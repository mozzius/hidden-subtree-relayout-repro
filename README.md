# Commits under a `display: 'none'` view re-lay out the whole surface (new architecture)

Yoga never clears the dirty flags of the descendants of a `display: 'none'`
node. When it lays out the hidden node's parent, it zeroes out the hidden
subtree and marks the hidden node itself clean, but leaves everything below it
as it was. So a view that was created or changed while its ancestor was
hidden stays dirty until the ancestor is shown again.

`YogaLayoutableShadowNode::updateYogaChildren` marks a cloned node dirty if
any of its children is dirty. A ShadowTree commit clones every ancestor of
the changed node, so **any commit that touches something under the hidden
node dirties the hidden node, and from there the root**.
`RootShadowNode::layoutIfNeeded` then re-runs Yoga layout, including
`roundLayoutResultsToPixelGrid` over every node in the surface. None of that
work can change anything, because a `display: 'none'` node is zero-sized
whatever its children are.

In core React Native, the realistic trigger is a JS-driven `Animated` loop
(`useNativeDriver: false`) on a view inside a `display: 'none'` container,
e.g. a spinner or a loading shimmer in a collapsed section. On Fabric, JS-driven
Animated applies each frame with `setNativeProps`, which commits to the
ShadowTree, so the hidden animation pays for a full layout pass on every
frame. Animation libraries that commit to the ShadowTree hit the same path. We
found this in the Bluesky app through a Reanimated `useAnimatedStyle` on a
hidden pull-to-refresh spinner in a profile header, which re-ran layout on
every scroll frame.

React's `<Activity mode="hidden">` hides its content the same way, and leaves
stale-dirty nodes behind whenever it pre-renders or re-renders hidden content.
In practice, though, the only way we found for core APIs to commit into a
hidden Activity outside React was `setNativeProps` on an instance captured
before hiding. See [`<Activity>`](#activity) below.

This is a sibling of the Modal bug in
[mozzius/modal-relayout-repro](https://github.com/mozzius/modal-relayout-repro)
([react/react-native#59100](https://github.com/react/react-native/issues/59100)):
the same symptom (commits that don't go through React re-run layout over the
whole surface), with a different cause.

## Filed as

- React Native: <ISSUE_URL>
- Fix: <PR_URL> (the `fixed` branch of this repo applies the same change)

## Environment

| | |
| --- | --- |
| react-native | 0.87.1 |
| react | 19.2.3 |
| Architecture | New (Fabric), Hermes |
| Reproduced on | iOS Simulator, iPhone 17, iOS 26.5, Release build (Xcode 27.0) |
| Dependencies | None beyond the template |

## Steps to reproduce

```bash
cd ReproducerApp
yarn install
(cd ios && bundle install && bundle exec pod install)
yarn ios --mode Release
```

Tap **Run all**. The app runs every scenario below 3 times, alternating the
order, and prints the median and p90 time per commit for each run. A full run
takes about two minutes.

You can also start it from the command line:

```bash
xcrun simctl launch booted org.reactjs.native.example.ReproducerApp -autorun 1
```

### Expected

Every scenario only changes a color or an opacity, so no commit should touch
layout. The scenarios with a hidden view should cost the same as the
controls.

### Actual

Commits under a hidden view whose subtree was created or changed while hidden
re-lay out the whole surface. Everything else runs no layout at all.

Per-commit time in ms, median / p90. Each cell is the median over 9 runs of
120 commits (3 app launches × 3 rounds, launches alternating between the two
builds). Both builds are React Native 0.87.1 built from source; the "fixed"
column adds the patch from the `fixed` branch.

| Scenario | stock | fixed |
| --- | ---: | ---: |
| `visible` (control) | 0.19 / 0.23 | 0.19 / 0.24 |
| `opacity0` (control) | 0.17 / 0.23 | 0.17 / 0.22 |
| **`hidden`** | **1.06 / 2.02** | 0.15 / 0.21 |
| `hiddenAfterLayout` | 0.15 / 0.23 | 0.16 / 0.20 |
| **`hiddenThenChanged`** | **1.01 / 2.06** | 0.16 / 0.20 |
| `hiddenSibling` (control) | 0.18 / 0.23 | 0.18 / 0.22 |
| `activityAfterLayout` | 0.15 / 0.22 | 0.16 / 0.23 |
| **`activityThenChanged`** | **1.18 / 2.03** | 0.16 / 0.21 |
| `activitySibling` (control) | 0.11 / 0.24 | 0.13 / 0.23 |
| `animatedJsVisible` (control) | 0.14 / 0.18 | 0.15 / 0.18 |
| **`animatedJsHidden`** | **1.09 / 1.95** | 0.13 / 0.17 |

The prebuilt React Native core (`bundle exec pod install` without
`RCT_USE_PREBUILT_RNCORE=0`) measured the same as stock from source: 1.12 /
2.01 ms for `hidden` and 1.09 / 1.98 ms for `animatedJsHidden`, with the
controls at 0.15–0.19 ms (6 runs).

Counting with lldb (a breakpoint on
`YogaLayoutableShadowNode::layoutTree`) gives the same split. On stock, each
of the 120 commits in `hidden`, `hiddenThenChanged` and `activityThenChanged`
ran a layout pass, and so did every frame of `animatedJsHidden`. None of the
`setNativeProps` commits in the other scenarios ran one. With the fix, none of
the `setNativeProps` commits in any scenario ran a layout pass.

## Scenarios

Each scenario mounts a fresh stage above the 1000-row list (`ROW_COUNT` in
`App.tsx`), then changes an 80×40 target view once per frame, 120 times. The
`color` scenarios set its background color with `setNativeProps`, and time
each call. That call is one synchronous ShadowTree commit on the JS thread:
`ShadowNode::cloneTree`, layout and commit hooks. The `animated` scenarios run
an `Animated.loop` with `useNativeDriver: false` on the target's opacity. They
time the `setNativeProps` calls Animated makes, by wrapping the instance's
`setNativeProps`.

- **`visible`**: the target in a visible container.
- **`opacity0`**: the container has `opacity: 0`, so it's invisible but still
  laid out by Yoga.
- **`hidden`**: the container has `display: 'none'`, and the target was
  mounted with it, so it was created while hidden.
- **`hiddenAfterLayout`**: the target is laid out while visible, then the
  container is hidden with a React state change. Nothing under it changes
  while hidden, so its children are clean.
- **`hiddenThenChanged`**: as `hiddenAfterLayout`, then React re-renders a
  `<Text>` sibling of the target while the container is hidden.
- **`hiddenSibling`**: the target is a visible sibling of a hidden container
  whose children were created while hidden. The hidden node isn't an ancestor
  of the target, so the commit doesn't clone it.
- **`activityAfterLayout`**, **`activityThenChanged`**: like the
  `hiddenAfterLayout` scenarios, but hidden with
  `<Activity mode="hidden">`. Activity detaches refs when it hides, so the
  target instance is captured before hiding.
- **`activitySibling`**: a visible target next to an Activity that was
  pre-rendered hidden.
- **`animatedJsVisible`**, **`animatedJsHidden`**: a JS-driven Animated loop
  on a target in a visible container, or one created inside a
  `display: 'none'` container.

## `<Activity>`

`<Activity mode="hidden">` hides its content with exactly this pattern. The
Fabric renderer's `cloneHiddenInstance` (`ReactFabric-prod.js`) clones each
top-level host node of the hidden content with new props and keeps its
children:

```js
function cloneHiddenInstance(instance) {
  var node = instance.node,
    updatePayload = ReactNativePrivateInterface.createAttributePayload(
      { style: { display: "none" } },
      instance.canonical.viewConfig.validAttributes
    );
  return {
    node: cloneNodeWithNewProps(node, updatePayload),
    canonical: instance.canonical
  };
}
```

Suspense hides already-shown content behind a fallback through the same
function. We didn't test Suspense separately.

**Activity creates stale-dirty nodes routinely.** Pre-rendering
(`mode="hidden"` from the start) creates the whole subtree while hidden.
Updates to hidden content still render, at offscreen priority, and commit
under the hidden node. `activityThenChanged` shows the result: a commit
under the hidden content re-runs layout from the root on every commit.

**But commits that don't go through React rarely reach it.** When an
Activity hides, React detaches every ref in it, unmounts its layout effects
and calls `componentWillUnmount` on its class components
(`recursivelyTraverseDisappearLayoutEffects`). We probed what still commits
into a hidden Activity, counting commits with lldb (stock and fixed
behaved the same):

| What | Commits while hidden |
| --- | --- |
| `setNativeProps` on an instance captured before hiding | Yes, 1 per call. Each one re-runs layout on stock if anything under the Activity changed while hidden (`activityThenChanged`), none with the fix. |
| JS-driven `Animated.loop`, started while visible | No. 61 `setNativeProps` calls in 1 s while visible, 0 in 2 s once hidden: the ref cleanup in `useAnimatedProps` drops the update callback. |
| Native-driven `Animated.loop`, started while visible | No. It doesn't commit to the ShadowTree while visible either (`cxxNativeAnimatedEnabled` is off by default in OSS). |
| `ScrollView.scrollTo()` on an instance captured before hiding | No. 60 `contentOffset` state updates while visible, 0 while hidden. |
| A `ScrollView`, a remote `Image`, a `TextInput` and an `ActivityIndicator`, idle | No commits while pre-rendered hidden or hidden after being shown. One state update while visible. |

So in core React Native, Activity only triggers this bug through a stale
instance captured before hiding, which is contrived. Third-party libraries
that commit to the ShadowTree without going through refs could still reach
hidden content. We didn't test any.

A plain `display: 'none'` view is different: refs stay attached and effects
keep running, so a JS-driven animation keeps committing
(`animatedJsHidden`).

## Root cause

Yoga lays out a `display: 'none'` child like this
(`ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp`):

```cpp
if (child->style().display() == Display::None) {
  if (performLayout) {
    zeroOutLayoutRecursively(child);
    child->setHasNewLayout(true);
    child->setDirty(false);
  }
  continue;
}
```

`zeroOutLayoutRecursively` resets the layout of every descendant but never
touches their dirty flags. Fabric's `YogaLayoutableShadowNode::layout` doesn't
recurse into `display: none` children either. New Yoga nodes start dirty, and
a React commit dirties every node it clones with new children
(`appendChild`), so anything created or changed under a hidden node stays
dirty while it's hidden.

`YogaLayoutableShadowNode::updateYogaChildren`
(`ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp`)
runs on every clone that gets a new child list, which is every ancestor in
`ShadowNode::cloneTree`:

```cpp
bool isClean = !YGNodeIsDirty(&yogaNode_) &&
    getChildren().size() == YGNodeGetChildCount(&yogaNode_);
...
      if (isClean) {
        ...
        isClean = isClean && !newYogaChildNode.isDirty() &&
            (newYogaChildNode.style() == oldYogaChildNode.style());
      }
...
yogaNode_.setDirty(!isClean);
```

The hidden node sees its stale-dirty child, marks itself dirty, and each
ancestor above it does the same.

A breakpoint on `yoga::Node::setDirty` (stopping only on `setDirty(true)`)
in the `hidden` scenario shows the first node to turn dirty in each
`setNativeProps` commit. The first line reads the node's state with
`YGNodeIsDirty`, `YGNodeStyleGetDisplay` and `YGNodeGetChildCount` before the
call:

```
node: wasDirty=0 display=none children=2
yoga::Node::setDirty
YogaLayoutableShadowNode::updateYogaChildren
YogaLayoutableShadowNode::YogaLayoutableShadowNode
ViewShadowNode::ViewShadowNode
...
ConcreteComponentDescriptor<ViewShadowNode>::cloneShadowNode
ShadowNode::clone
ShadowNode::cloneTree
UIManager::setNativeProps_DEPRECATED::$_0::operator()::'lambda'
ShadowTree::tryCommit
ShadowTree::commit
UIManager::setNativeProps_DEPRECATED
NativeDOM::setNativeProps
```

`hiddenThenChanged`, `activityThenChanged` and `animatedJsHidden` show the
same stack. In the controls, no node turns dirty during the clone. After
each layout pass, Yoga's `display: none` branch marks the hidden node clean
again, and the next commit dirties it again.

## Why the repro doesn't time React commits

A React commit lays out from the root whether or not anything is hidden:

- The Fabric renderer clones each ancestor with
  `cloneNodeWithNewChildren(node)` and an empty child list, then calls
  `appendChild` for each child.
- `YogaLayoutableShadowNode::appendChild` always dirties the node, because
  it has nothing to compare the Yoga node with.

The commits that pay for this bug are the ones that don't go through React:
`setNativeProps`, JS-driven Animated, native state updates such as a
ScrollView's `contentOffset`, and animation libraries that commit to the
ShadowTree.

## The `fixed` branch

The `fixed` branch adds the fix as a `patch-package` patch
(`ReproducerApp/patches/react-native+0.87.1.patch`). With it,
`updateYogaChildren` doesn't compare the children of a `display: none` node,
because they can't change its layout. It still checks the node's own dirty
flag and child count. Showing the node again changes its style, which
dirties it in `updateYogaProps`.

The core has to be built from source for the patch to take effect:

```bash
git checkout fixed
cd ReproducerApp
yarn install    # postinstall applies the patch
(cd ios && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install)
yarn ios --mode Release
```

To check that showing a view again still lays it out, launch with
`-scenario unhide`:

```bash
xcrun simctl launch booted org.reactjs.native.example.ReproducerApp -scenario unhide
```

It hides three containers, re-renders a label inside each while hidden,
changes each target's color 30 times with `setNativeProps`, then shows them
again: one with `setNativeProps({style: {display: 'flex'}})`, one with a
React state change and one by switching an Activity back to visible. Every
row lays out the same as the never-hidden reference row on both builds. The
Activity row keeps its initial color on both builds: React commits its own
nodes when it shows an Activity, which drops `setNativeProps` changes made
while it was hidden.

## What is and is not needed

**Required:**

- A `display: 'none'` view whose subtree was created or changed while it was
  hidden. A subtree laid out before hiding and left alone stays clean
  (`hiddenAfterLayout`, `activityAfterLayout`).
- A commit that doesn't go through React and changes something under the
  hidden view. Commits elsewhere in the tree don't clone the hidden view, so
  they don't see its dirty children (`hiddenSibling`, `activitySibling`).
- Enough nodes in the rest of the surface for a full pass to cost something.

**Not required:**

- Any third-party library. JS-driven `Animated` is enough.
- Navigation, Reanimated or `react-native-screens`.
- A physical device.

**Not tested:**

- Android. The code involved is shared C++, so we expect the same result.
- Suspense fallbacks, which hide content through the same path as Activity.

## Measurement notes

- Simulator timings depend on whether the JS thread lands on a performance or
  an efficiency core. On stock, the median of a single run of an affected
  scenario ranged from 0.41 to 1.38 ms, and its p90 from 1.77 to 2.25 ms.
- Every other run, on every build, had a median between 0.06 and 0.23 ms and
  a p90 under 0.3 ms.
- lldb slows the app down, so we only used it to count commits and layout
  passes, never for timings.
