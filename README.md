# Any commit under a `<Modal>` re-lays out the whole surface (new architecture)

`ModalHostViewComponentDescriptor::adopt()` calls
`YogaLayoutableShadowNode::setSize()` and `setPositionType()` on every clone of
the `ModalHostView`. Both mark the Yoga node dirty even when nothing changed.
A ShadowTree commit clones the path from the changed node up to the root, so
**any commit that touches anything inside a visible `<Modal>` dirties the
root**. `RootShadowNode::layoutIfNeeded` then re-runs Yoga layout, including
`roundLayoutResultsToPixelGrid` over every node in the surface, even if the
commit only changed a scroll offset or a color.

The most common way to hit this is scrolling a list inside a Modal (a bottom
sheet, a picker). Every scroll event commits a `contentOffset` state update,
and each of those commits re-lays out the entire screen behind the Modal.

The same pattern was found and fixed in react-native-screens
([software-mansion/react-native-screens#4922](https://github.com/software-mansion/react-native-screens/pull/4922)),
where pixel-grid rounding was about 90% of the layout time in the Bluesky app.

## Filed as

- React Native: [react/react-native#59100](https://github.com/react/react-native/issues/59100)
- Fix: [react/react-native#59101](https://github.com/react/react-native/pull/59101) (the `fixed` branch of this repo applies the same change)

## Environment

| | |
| --- | --- |
| react-native | 0.87.1 |
| react | 19.2.3 |
| Architecture | New (Fabric), Hermes |
| Reproduced on | iOS Simulator, iPhone 17, iOS 26.5, Release build (Xcode 27.0) |
| Also reproduced on | Android emulator, Pixel 9, API 36, Release build (`setNativeProps` trigger only, see below) |
| Dependencies | None beyond the template. No navigation, no Reanimated, no `react-native-screens` |

## Steps to reproduce

```bash
cd ReproducerApp
yarn install
(cd ios && bundle install && bundle exec pod install)
yarn ios --mode Release
```

The main screen renders 1000 rows (`ROW_COUNT` in `App.tsx`), so a full
layout pass is expensive enough to measure.

### 1. Scrolling (needs a profiler)

1. Attach Instruments' Time Profiler (or any sampling profiler) to the app.
2. Scroll the main list a few times.
3. Tap **Open scroll Modal** and scroll the list inside the Modal the same way.
4. Compare the time spent under `RootShadowNode::layoutIfNeeded` on the
   `com.facebook.react.runtime.JavaScript` thread.

### 2. `setNativeProps` (on screen, no profiler)

1. Tap **Run outside Modal** and wait for the result line.
2. Tap **Run inside Modal** and wait for the result line.

### Expected

Neither trigger changes anything layout-related, so commits inside the Modal
should cost the same as commits outside it, and neither should run layout.

### Actual

Commits inside the Modal re-lay out the whole surface. Outside the Modal they
don't run layout at all.

**Scrolling** (iOS)

- The run was 8 identical swipes, no momentum: 4 scrolling down, then 4
  scrolling back up.
- Sampled with Time Profiler at 1 ms.
- The window runs from 0.3 s before the first `scrollViewDidScroll` sample to
  1 s after the last.
- Each column is the mean of 3 runs, run alternately.

| JS thread | outside Modal | inside Modal | inside Modal, fixed |
| --- | ---: | ---: | ---: |
| busy | 32 ms | **176 ms** | 43 ms |
| in state-update commits (`UIManager::updateState`) | 3 ms | **135 ms** | 13 ms |
| … in `RootShadowNode::layoutIfNeeded` | 0 ms | **129 ms** | 0 ms |
| … in `roundLayoutResultsToPixelGrid` | 0 ms | **124 ms** | 0 ms |

Counting with lldb in separate runs, the same swipes produced:

- outside: 188 state updates and 0 layout passes;
- inside: 160 state updates and 152 layout passes.

That's about 0.85 ms of layout per scroll event, on a simulator running on a
desktop CPU. lldb slows the app down, so the counts are approximate.

**`setNativeProps`** (iOS): per-commit time measured on screen, 120 commits
per run. Mean of 3 alternating pairs:

| | outside Modal, median / p90 | inside Modal, median / p90 |
| --- | ---: | ---: |
| stock | 0.18 / 0.22 ms | **1.47 / 2.00 ms** |
| fixed | 0.20 / 0.24 ms | 0.22 / 0.27 ms |

**Android emulator**

- 5 pairs, measured on an earlier revision of this app that still used
  `react-native-safe-area-context`.
- The medians were 0.77 ms outside and **19.9 ms** inside.
- Perfetto puts the inside time on the JS thread in
  `fmod <- [unsymbolised Yoga rounding frames] <- YogaLayoutableShadowNode::layoutTree <- ShadowTree::tryCommit <- UIManager::setNativeProps_DEPRECATED`.

## Controls

- **Run outside Modal** / **Run inside Modal** mount a small view, either in
  the main screen or inside a transparent `<Modal>`. The view then changes its
  own background color once per frame, 120 times, with `setNativeProps`.
  - Each sample times one `setNativeProps` call. That call is one synchronous
    ShadowTree commit on the JS thread: `ShadowNode::cloneTree`, layout and
    mount.
  - The result line shows the median and p90.
- **Open scroll Modal** opens a transparent `<Modal>` with a 60-row
  `ScrollView` over the main list. **Close scroll Modal** closes it.
- `ROW_COUNT` sets how many rows the main screen renders, and so how expensive
  a full layout pass is.

## Root cause

Every clone of a `ModalHostView` runs its descriptor's `adopt()`
(`ReactCommon/react/renderer/components/modal/ModalHostViewComponentDescriptor.h`):

```cpp
void adopt(ShadowNode &shadowNode) const override
{
  auto &layoutableShadowNode = static_cast<YogaLayoutableShadowNode &>(shadowNode);
  auto &stateData = static_cast<const ModalHostViewShadowNode::ConcreteState &>(*shadowNode.getState()).getData();

  layoutableShadowNode.setSize(Size{.width = stateData.screenSize.width, .height = stateData.screenSize.height});
  layoutableShadowNode.setPositionType(YGPositionTypeAbsolute);

  ConcreteComponentDescriptor::adopt(shadowNode);
}
```

`setSize` and `setPositionType` dirty the node unconditionally
(`ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:587`
and `:624`). `setPadding`, in between them at `:599`, compares the new value
first:

```cpp
void YogaLayoutableShadowNode::setSize(Size size) const {
  ensureUnsealed();

  auto style = yogaNode_.style();
  style.setDimension(
      yoga::Dimension::Width, yoga::StyleSizeLength::points(size.width));
  style.setDimension(
      yoga::Dimension::Height, yoga::StyleSizeLength::points(size.height));
  yogaNode_.setStyle(style);
  yogaNode_.setDirty(true);
}
```

The path from a scroll event to the full layout pass:

1. `UIManager::updateState` (or `setNativeProps_DEPRECATED`) calls
   `ShadowTree::commit`.
2. `ShadowNode::cloneTree` clones every ancestor of the changed node, including
   the `ModalHostView`.
3. `ModalHostViewComponentDescriptor::adopt` runs on that clone and calls
   `setSize`, which calls `yoga::Node::setDirty(true)`.
4. `updateYogaChildren` on each ancestor sees a dirty child and dirties itself,
   all the way up to the `RootView`.
5. `RootShadowNode::layoutIfNeeded` calls `YogaLayoutableShadowNode::layoutTree`,
   which calls `roundLayoutResultsToPixelGrid`.

A breakpoint on `yoga::Node::setDirty` confirms this:

- **Inside the Modal**, every scroll commit starts with exactly this chain:
  `setSize <- ModalHostViewComponentDescriptor::adopt <- ConcreteComponentDescriptor<ModalHostViewShadowNode>::cloneShadowNode <- ShadowNode::clone <- ShadowNode::cloneTree <- UIManager::updateState <- ShadowTree::tryCommit`.
  It then propagates to the root.
- **Outside the Modal**, the same scroll commits turn no Yoga node from clean
  to dirty.

Yoga's measurement cache keeps `calculateLayoutImpl` cheap for the clean
siblings. But `roundLayoutResultsToPixelGrid` (`yoga/algorithm/PixelGrid.cpp`)
recurses into every node of the tree whenever the root is laid out. That's
where the time goes.

## Why the repro doesn't time React state updates

A React commit can't show this bug, because every React commit already
dirties every ancestor up to the root, Modal or not:

- The Fabric renderer clones each ancestor with
  `cloneNodeWithNewChildren(node)` and an empty child list, then calls
  `appendChild` for each child (`ReactFabric-prod.js`, `completeWork`).
- `YogaLayoutableShadowNode::appendChild` always dirties the node: "we don't
  have anything to compare the Yoga node with … Therefore we must dirty the
  node" (`YogaLayoutableShadowNode.cpp:241`).
- `UIManagerBinding.cpp` already accepts a child list. Lines 330, 383, 423 and
  440 carry TODOs that reference `passChildrenWhenCloningPersistedNodes`, but
  the renderer shipped in react-native doesn't pass one.

An earlier version of this repro timed a React state change from render to
`useLayoutEffect`. It measured the same about 1 ms of full layout per commit
inside and outside the Modal. The commits that pay for the Modal bug are the
ones that don't go through React: state updates such as scrolling,
`setNativeProps`, and animation libraries that commit to the ShadowTree.

## The `fixed` branch

The `fixed` branch adds the fix as a `patch-package` patch
(`ReproducerApp/patches/react-native+0.87.1.patch`). With it, `setSize` and
`setPositionType` return early when the value is unchanged. The core has to be
built from source for the patch to take effect:

```bash
git checkout fixed
cd ReproducerApp
yarn install    # postinstall applies the patch
(cd ios && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install)
yarn ios --mode Release
```

The "fixed" columns above come from this branch. On an earlier revision, a
stock from-source build measured the same as the prebuilt one
(`setNativeProps`: 0.13 ms outside, 1.02 ms inside), so the build mode isn't
what makes the difference.

## What is and is not needed

**Required:**

- A visible `<Modal>` with the changed node inside it.
- A commit that doesn't go through React, such as a ScrollView `contentOffset`
  state update or `setNativeProps`.
- Enough nodes in the rest of the surface for a full pass to cost something.
  On an earlier revision the gap was already visible with 250 rows: 0.29 vs
  0.67 ms per `setNativeProps` commit.

**Not required:**

- `react-native-safe-area-context`. Earlier revisions used it, and removing it
  didn't change the result (0.19 vs 1.10 ms before, 0.18 vs 1.47 ms after).
- Navigation, Reanimated or `react-native-screens`.
- A physical device.

**Not tested:**

- A non-transparent Modal.
- Modal animation types other than `none`.

## Measurement notes

- Simulator timings depend on whether the JS thread lands on a performance or
  an efficiency core. Absolute sub-millisecond numbers moved between sessions:
  inside-Modal `setNativeProps` medians ranged from 0.46 to 1.57 ms.
- Inside vs outside was consistently about 6–8× for `setNativeProps`. For
  scrolling, the inside Modal runs layout on nearly every commit, and the
  outside runs none.
- The Android numbers come from the emulator. Treat them as a second data point
  rather than device performance.
