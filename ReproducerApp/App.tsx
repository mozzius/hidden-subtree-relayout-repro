/**
 * Repro: a commit that clones a `display: 'none'` view together with its
 * children re-runs Yoga layout over the *whole* surface if any of those
 * children is dirty. Children that were created or changed while the view
 * was hidden stay dirty for as long as it stays hidden, so every such commit
 * pays for a full layout pass.
 *
 * Why the children stay dirty: when Yoga lays out a `display: none` child it
 * zeroes out the child's subtree (`zeroOutLayoutRecursively`) and marks the
 * child itself clean, but never clears the dirty flags of the child's
 * descendants. Fabric's `YogaLayoutableShadowNode::layout` doesn't recurse
 * into `display: none` nodes either. So a descendant that was dirty when the
 * view was hidden stays dirty until the view is shown again.
 *
 * Why that dirties the root: `ShadowNode::cloneTree` clones every ancestor of
 * the changed node with a new children list, and
 * `YogaLayoutableShadowNode::updateYogaChildren` marks a cloned node dirty if
 * any of its children is dirty. When the hidden view is one of those
 * ancestors, it sees its stale-dirty child, dirties itself, and every
 * ancestor above it follows. `RootShadowNode::layoutIfNeeded` then lays out
 * the whole tree, including `roundLayoutResultsToPixelGrid` over every node.
 *
 * React commits don't show this, because React's Fabric renderer clones every
 * ancestor with an empty child list and then calls `appendChild`, which
 * always dirties. Every React commit lays out from the root anyway. The
 * commits that pay for the bug are the ones that don't go through React:
 * `setNativeProps`, JS-driven `Animated` (which uses `setNativeProps` on
 * Fabric), native state updates such as ScrollView `contentOffset`, and
 * animation libraries that commit to the ShadowTree.
 *
 * Each timed scenario changes a target view once per frame, FRAME_COUNT
 * times, and times each `setNativeProps` call. That call is one synchronous
 * ShadowTree commit on the JS thread (`cloneTree`, layout and commit hooks).
 * The main screen renders ROW_COUNT rows, so a full layout pass is expensive
 * enough to show up.
 *
 * Launch arguments (iOS, read with `Settings`):
 *   -autorun 1         run every timed scenario ROUNDS times, alternating
 *   -probe all         run the timed scenarios once, then the commit probes,
 *                      marking each phase with `Settings.set({phase})` so a
 *                      debugger can attribute commits and layout passes
 *   -only a,b          only run the named timed scenarios
 *   -scenario unhide   render the un-hiding check (see UnhideCheck)
 * Results are shown on screen and saved to `Settings` under `results`.
 *
 * @format
 */

import React, { Activity, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Button,
  Image,
  Platform,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

/** Rows in the main screen. Layout cost scales with this. */
const ROW_COUNT = 1000;
/** Commits per timed run. */
const FRAME_COUNT = 120;
/** How many times `-autorun` runs each timed scenario. */
const ROUNDS = 3;
const COLORS = ['#f4cccc', '#d9ead3', '#cfe2f3', '#fff2cc'];
const FINAL_COLOR = '#6fa8dc';

type HostInstance = React.ComponentRef<typeof View>;
type ScrollViewInstance = React.ComponentRef<typeof ScrollView>;
type ScrollSlot = { current: ScrollViewInstance | null };
type Slot = { current: HostInstance | null };
type Result = { median: number; p90: number; samples: number };

const HIDE = { display: 'none' } as const;

/** Provided by Hermes; the template's TS config has no DOM types. */
declare const performance: { now(): number };

function summarize(samples: number[]): Result {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { median: at(0.5), p90: at(0.9), samples: sorted.length };
}

function formatResult(result: Result) {
  return `${result.median.toFixed(2)}/${result.p90.toFixed(2)}`;
}

const nextFrame = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const wait = (ms: number) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), ms));
async function frames(count: number) {
  for (let i = 0; i < count; i++) {
    await nextFrame();
  }
}

/**
 * Marks a phase for a debugger, which can break on
 * `-[RCTSettingsManager setValues:]`.
 */
function mark(phase: string) {
  if (Platform.OS === 'ios') {
    Settings.set({ phase });
  }
}

/**
 * A callback ref that keeps the last non-null instance. `<Activity>` detaches
 * refs when it hides, so this is the only way to reach a node inside a hidden
 * Activity from JS.
 */
function keep(slot: Slot) {
  return (instance: HostInstance | null) => {
    if (instance != null) {
      slot.current = instance;
    }
  };
}

/** Times every `setNativeProps` call made on an instance (e.g. by Animated). */
const animatedSink = { samples: [] as number[], calls: 0 };
function instrument(slot: Slot) {
  return (instance: HostInstance | null) => {
    if (instance == null) {
      return;
    }
    slot.current = instance;
    const patched = instance as HostInstance & { __timed?: boolean };
    if (patched.__timed) {
      return;
    }
    patched.__timed = true;
    const original = instance.setNativeProps;
    patched.setNativeProps = (props: object) => {
      const start = performance.now();
      original.call(instance, props);
      animatedSink.samples.push(performance.now() - start);
      animatedSink.calls++;
    };
  };
}

/** Changes the target's color once per frame and times each commit. */
async function tickColor(slot: Slot): Promise<Result> {
  const target = slot.current;
  if (target == null) {
    throw new Error('no target');
  }
  const samples: number[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    await nextFrame();
    const start = performance.now();
    target.setNativeProps({
      style: { backgroundColor: COLORS[(i + 1) % COLORS.length] },
    });
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

function jsLoop(value: Animated.Value) {
  return Animated.loop(
    Animated.timing(value, {
      toValue: 1,
      duration: 500,
      useNativeDriver: false,
    }),
  );
}

function nativeLoop(value: Animated.Value) {
  return Animated.loop(
    Animated.timing(value, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }),
  );
}

/** Runs a JS-driven loop and times the `setNativeProps` calls it makes. */
async function tickAnimated(value: Animated.Value): Promise<Result> {
  animatedSink.samples = [];
  const loop = jsLoop(value);
  loop.start();
  const deadline = Date.now() + 10_000;
  while (animatedSink.samples.length < FRAME_COUNT && Date.now() < deadline) {
    await nextFrame();
  }
  loop.stop();
  if (animatedSink.samples.length === 0) {
    throw new Error('no setNativeProps calls');
  }
  return summarize(animatedSink.samples.slice(0, FRAME_COUNT));
}

function Rows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.avatar} />
          <View style={styles.rowText}>
            <Text>Row {index}</Text>
            <Text style={styles.subtitle}>Some secondary text</Text>
          </View>
        </View>
      ))}
    </>
  );
}

/**
 * The contents of a (possibly hidden) container: the target view and a label
 * that some scenarios change while the container is hidden.
 */
function Contents({ slot, label }: { slot: Slot; label: string }) {
  return (
    <>
      <View ref={keep(slot)} style={styles.target} />
      <Text>{label}</Text>
    </>
  );
}

type StageProps = { step: number; slot: Slot; value: Animated.Value };
type StageRender = (props: StageProps) => React.ReactNode;

type TimedScenario = {
  name: string;
  /** Number of React state steps to apply after mounting, one at a time. */
  steps?: number;
  /** Extra wait after each step, e.g. for an offscreen render to commit. */
  settleMs?: number;
  /**
   * `color` sets the target's background color with setNativeProps, and
   * `animated` runs a JS-driven Animated loop on the target.
   */
  tick?: 'color' | 'animated';
  render: StageRender;
};

const UNUSED_SLOT: Slot = { current: null };

/**
 * Every timed scenario. The comment says what we expect; the measurement is
 * what decides.
 */
const TIMED: TimedScenario[] = [
  // Control: the target in a visible container.
  {
    name: 'visible',
    render: ({ slot }) => (
      <View style={styles.box}>
        <Contents slot={slot} label="initial" />
      </View>
    ),
  },
  // Control: the container is invisible but still laid out by Yoga.
  {
    name: 'opacity0',
    render: ({ slot }) => (
      <View style={[styles.box, styles.invisible]}>
        <Contents slot={slot} label="initial" />
      </View>
    ),
  },
  // Bug: the target was created while its container was display: none.
  {
    name: 'hidden',
    render: ({ slot }) => (
      <View style={[styles.box, HIDE]}>
        <Contents slot={slot} label="initial" />
      </View>
    ),
  },
  // The target was laid out before the container was hidden, and nothing
  // inside changed while hidden, so the container's children are clean.
  {
    name: 'hiddenAfterLayout',
    steps: 1,
    render: ({ slot, step }) => (
      <View style={[styles.box, step >= 1 && HIDE]}>
        <Contents slot={slot} label="initial" />
      </View>
    ),
  },
  // As above, then React re-renders a label inside while it's hidden.
  {
    name: 'hiddenThenChanged',
    steps: 2,
    render: ({ slot, step }) => (
      <View style={[styles.box, step >= 1 && HIDE]}>
        <Contents slot={slot} label={step >= 2 ? 'changed' : 'initial'} />
      </View>
    ),
  },
  // Control: the target is a visible sibling of a hidden container whose
  // children are stale-dirty. The hidden view isn't an ancestor of the
  // target, so the commit doesn't clone it.
  {
    name: 'hiddenSibling',
    render: ({ slot }) => (
      <View style={styles.box}>
        <View ref={keep(slot)} style={styles.target} />
        <View style={[styles.box, HIDE]}>
          <Contents slot={UNUSED_SLOT} label="initial" />
        </View>
      </View>
    ),
  },
  // Activity hidden after its contents were laid out. The ref is captured
  // before hiding (Activity detaches refs when it hides).
  {
    name: 'activityAfterLayout',
    steps: 1,
    settleMs: 300,
    render: ({ slot, step }) => (
      <Activity mode={step >= 1 ? 'hidden' : 'visible'}>
        <View style={styles.box}>
          <Contents slot={slot} label="initial" />
        </View>
      </Activity>
    ),
  },
  // As above, then a prop change re-renders the hidden Activity's contents
  // (React renders hidden Activity updates at offscreen priority).
  {
    name: 'activityThenChanged',
    steps: 2,
    settleMs: 500,
    render: ({ slot, step }) => (
      <Activity mode={step >= 1 ? 'hidden' : 'visible'}>
        <View style={styles.box}>
          <Contents slot={slot} label={step >= 2 ? 'changed' : 'initial'} />
        </View>
      </Activity>
    ),
  },
  // Control: a visible sibling of an Activity that was pre-rendered hidden
  // (so all of its contents were created while hidden).
  {
    name: 'activitySibling',
    settleMs: 500,
    render: ({ slot }) => (
      <View style={styles.box}>
        <View ref={keep(slot)} style={styles.target} />
        <Activity mode="hidden">
          <View style={styles.box}>
            <Contents slot={UNUSED_SLOT} label="initial" />
          </View>
        </Activity>
      </View>
    ),
  },
  // Control: a JS-driven Animated loop (one setNativeProps per frame) on a
  // visible view.
  {
    name: 'animatedJsVisible',
    tick: 'animated',
    render: ({ slot, value }) => (
      <View style={styles.box}>
        <Animated.View
          ref={instrument(slot)}
          style={[styles.target, { opacity: value }]}
        />
      </View>
    ),
  },
  // Bug: the same loop on a view created inside a display: none container,
  // e.g. a spinner or a skeleton shimmer in a collapsed section.
  {
    name: 'animatedJsHidden',
    tick: 'animated',
    render: ({ slot, value }) => (
      <View style={[styles.box, HIDE]}>
        <Animated.View
          ref={instrument(slot)}
          style={[styles.target, { opacity: value }]}
        />
      </View>
    ),
  },
];

type ProbeContext = {
  show: (render: StageRender) => Promise<void>;
  setStep: (step: number) => Promise<void>;
  slot: Slot;
  /** The Animated.Value the current stage renders with. */
  value: () => Animated.Value;
  scrollRef: ScrollSlot;
};

/**
 * Probes for commits that JS can't time (native state updates,
 * native-driven animations), or for whether anything commits at all. They
 * mark phases for a debugger. Any JS-side counts are returned as the probe's
 * result.
 */
const PROBES: {
  name: string;
  run: (ctx: ProbeContext) => Promise<Record<string, number> | void>;
}[] = [
  // Does a JS-driven Animated loop keep calling setNativeProps once its
  // Activity hides?
  {
    name: 'animatedJsActivity',
    run: async ({ show, setStep, slot, value }) => {
      await show(props => (
        <Activity mode={props.step >= 1 ? 'hidden' : 'visible'}>
          <View style={styles.box}>
            <Animated.View
              ref={instrument(props.slot)}
              style={[styles.target, { opacity: props.value }]}
            />
          </View>
        </Activity>
      ));
      const loop = jsLoop(value());
      loop.start();
      await frames(10);
      const visibleStart = animatedSink.calls;
      mark('animatedJsActivity:visible');
      await wait(1000);
      const visibleCalls = animatedSink.calls - visibleStart;
      await setStep(1);
      await wait(300);
      const hiddenStart = animatedSink.calls;
      mark('animatedJsActivity:hidden');
      await wait(2000);
      const hiddenCalls = animatedSink.calls - hiddenStart;
      mark('animatedJsActivity:done');
      loop.stop();
      slot.current = null;
      return { visibleCallsIn1s: visibleCalls, hiddenCallsIn2s: hiddenCalls };
    },
  },
  // Does a native-driven Animated loop commit to the ShadowTree, visible or
  // hidden?
  {
    name: 'animatedNativeActivity',
    run: async ({ show, setStep, value }) => {
      await show(props => (
        <Activity mode={props.step >= 1 ? 'hidden' : 'visible'}>
          <View style={styles.box}>
            <Animated.View style={[styles.target, { opacity: props.value }]} />
          </View>
        </Activity>
      ));
      const loop = nativeLoop(value());
      loop.start();
      await wait(300);
      mark('animatedNativeActivity:visible');
      await wait(1000);
      await setStep(1);
      await wait(300);
      mark('animatedNativeActivity:hidden');
      await wait(2000);
      mark('animatedNativeActivity:done');
      loop.stop();
    },
  },
  {
    name: 'animatedNativeHidden',
    run: async ({ show, value }) => {
      await show(props => (
        <View style={[styles.box, HIDE]}>
          <Animated.View style={[styles.target, { opacity: props.value }]} />
        </View>
      ));
      const loop = nativeLoop(value());
      loop.start();
      await wait(300);
      mark('animatedNativeHidden:hidden');
      await wait(2000);
      mark('animatedNativeHidden:done');
      loop.stop();
    },
  },
  // Programmatic scrolling commits a contentOffset state update per scroll.
  {
    name: 'scrollVisible',
    run: async ({ show, scrollRef }) => {
      await show(() => (
        <View style={styles.box}>
          <ScrollView ref={scrollRef} style={styles.smallList}>
            <Rows count={20} />
          </ScrollView>
        </View>
      ));
      await scrollEachFrame(scrollRef, 'scrollVisible:scroll');
    },
  },
  {
    name: 'scrollHidden',
    run: async ({ show, scrollRef }) => {
      await show(() => (
        <View style={[styles.box, HIDE]}>
          <ScrollView ref={scrollRef} style={styles.smallList}>
            <Rows count={20} />
          </ScrollView>
        </View>
      ));
      await scrollEachFrame(scrollRef, 'scrollHidden:scroll');
    },
  },
  // A ScrollView inside an Activity: scroll it while visible, hide it,
  // re-render its contents while hidden, then try to scroll it through the
  // ScrollView instance captured before hiding.
  {
    name: 'scrollActivity',
    run: async ({ show, setStep, scrollRef }) => {
      const captured: ScrollSlot = { current: null };
      await show(({ step }) => (
        <Activity mode={step >= 1 ? 'hidden' : 'visible'}>
          <View style={styles.box}>
            <ScrollView
              ref={instance => {
                scrollRef.current = instance;
                if (instance != null) {
                  captured.current = instance;
                }
              }}
              style={styles.smallList}
            >
              <Text>{step >= 2 ? 'changed' : 'initial'}</Text>
              <Rows count={20} />
            </ScrollView>
          </View>
        </Activity>
      ));
      await scrollEachFrame(scrollRef, 'scrollActivity:visible-scroll', 60);
      await setStep(1);
      await setStep(2);
      await wait(500);
      await scrollEachFrame(captured, 'scrollActivity:hidden-scroll', 60);
    },
  },
  // Native components that might commit on their own while hidden: an
  // Activity pre-rendered hidden, then shown, then hidden again.
  {
    name: 'activityIdle',
    run: async ({ show, setStep }) => {
      const uri = `https://reactnative.dev/img/tiny_logo.png?t=${Date.now()}`;
      await show(({ step }) => (
        <Activity mode={step === 1 ? 'visible' : 'hidden'}>
          <View style={styles.box}>
            <ScrollView style={styles.smallList}>
              <Rows count={20} />
            </ScrollView>
            <Image source={{ uri }} style={styles.image} />
            <TextInput defaultValue="text" style={styles.input} />
            <ActivityIndicator />
          </View>
        </Activity>
      ));
      mark('activityIdle:prerendered');
      await wait(3000);
      await setStep(1);
      mark('activityIdle:visible');
      await wait(3000);
      await setStep(2);
      await wait(300);
      mark('activityIdle:hidden');
      await wait(3000);
      mark('activityIdle:done');
    },
  },
];

async function scrollEachFrame(
  scrollRef: ScrollSlot,
  phase: string,
  count = FRAME_COUNT,
) {
  await wait(300);
  mark(phase);
  await wait(100);
  for (let i = 0; i < count; i++) {
    await nextFrame();
    scrollRef.current?.scrollTo({ y: i % 2 === 0 ? 20 : 0, animated: false });
  }
  await wait(300);
  mark(`${phase}:done`);
}

type Stage = { id: number; step: number; render: StageRender | null };

function App() {
  const [stage, setStageState] = useState<Stage>({
    id: 0,
    step: 0,
    render: null,
  });
  const [status, setStatus] = useState('idle');
  const [lines, setLines] = useState<string[]>([]);
  const slot = useRef<HostInstance | null>(null);
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  // A fresh value per stage: a value that has run a native-driven animation
  // can't be used by a JS-driven one afterwards.
  const valueRef = useRef(new Animated.Value(0));
  const running = useRef(false);

  const show = async (render: StageRender | null) => {
    slot.current = null;
    valueRef.current = new Animated.Value(0);
    setStageState(previous => ({ id: previous.id + 1, step: 0, render }));
    await frames(10);
  };
  const setStep = async (step: number) => {
    setStageState(previous => ({ ...previous, step }));
    await frames(10);
  };

  const runTimed = async (scenario: TimedScenario): Promise<Result> => {
    await show(scenario.render);
    for (let step = 1; step <= (scenario.steps ?? 0); step++) {
      await setStep(step);
      await wait(scenario.settleMs ?? 0);
    }
    await wait((scenario.settleMs ?? 0) + 200);
    mark(`${scenario.name}:tick`);
    await wait(100);
    const result =
      scenario.tick === 'animated'
        ? await tickAnimated(valueRef.current)
        : await tickColor(slot);
    await wait(100);
    mark(`${scenario.name}:done`);
    return result;
  };

  const runAll = async (rounds: number, probes: boolean) => {
    if (running.current) {
      return;
    }
    running.current = true;
    const timed: Record<string, Result[]> = {};
    const probeResults: Record<string, unknown> = {};
    const errors: string[] = [];
    try {
      for (let round = 0; round < rounds; round++) {
        const only = Platform.OS === 'ios' ? Settings.get('only') : null;
        const scenarios =
          typeof only === 'string'
            ? TIMED.filter(scenario => only.split(',').includes(scenario.name))
            : TIMED;
        const order = round % 2 === 0 ? scenarios : [...scenarios].reverse();
        for (const scenario of order) {
          setStatus(`round ${round + 1}/${rounds}: ${scenario.name}`);
          try {
            const result = await runTimed(scenario);
            (timed[scenario.name] ??= []).push(result);
          } catch (error) {
            errors.push(`${scenario.name}: ${String(error)}`);
          }
        }
      }
      if (probes) {
        for (const probe of PROBES) {
          setStatus(`probe: ${probe.name}`);
          try {
            const result = await probe.run({
              show,
              setStep,
              slot,
              value: () => valueRef.current,
              scrollRef,
            });
            if (result) {
              probeResults[probe.name] = result;
            }
          } catch (error) {
            errors.push(`${probe.name}: ${String(error)}`);
          }
        }
      }
    } finally {
      await show(null);
      running.current = false;
    }
    const output = [...errors];
    for (const scenario of TIMED) {
      const results = timed[scenario.name] ?? [];
      output.push(
        `${scenario.name}: ${results.map(formatResult).join('  ') || '-'}`,
      );
    }
    for (const [name, result] of Object.entries(probeResults)) {
      output.push(`${name}: ${JSON.stringify(result)}`);
    }
    setLines(output);
    setStatus('done');
    if (Platform.OS === 'ios') {
      Settings.set({
        results: JSON.stringify({
          runid: Settings.get('runid'),
          timed,
          probes: probeResults,
          errors,
        }),
      });
    }
    mark('all:done');
  };

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return;
    }
    if (Settings.get('autorun')) {
      setTimeout(() => runAll(ROUNDS, false), 1500);
    } else if (Settings.get('probe')) {
      setTimeout(() => runAll(1, true), 1500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (Platform.OS === 'ios' && Settings.get('scenario') === 'unhide') {
    return <UnhideCheck />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <Button
          title="Run all"
          disabled={status !== 'idle' && status !== 'done'}
          onPress={() => runAll(ROUNDS, false)}
        />
        <Text>{status}. Per-commit median/p90 ms, one entry per round:</Text>
        {lines.map(line => (
          <Text key={line} style={styles.result}>
            {line}
          </Text>
        ))}
      </View>
      {/* Keyed so every scenario mounts fresh instead of updating the last one. */}
      <View key={stage.id} style={styles.stage}>
        {stage.render?.({ step: stage.step, slot, value: valueRef.current }) ??
          null}
      </View>
      <ScrollView style={styles.list}>
        <Rows count={ROW_COUNT} />
      </ScrollView>
    </View>
  );
}

/**
 * Checks that showing a view again after it was hidden still lays out its
 * children correctly. Every row should have the same layout as the first one.
 *
 * The Activity row's box ends up in its initial color with or without the
 * fix: when an Activity is shown again, React commits the nodes it rendered,
 * so `setNativeProps` changes made while it was hidden are dropped.
 */
function UnhideCheck() {
  const [label, setLabel] = useState('initial');
  const [reactHidden, setReactHidden] = useState(true);
  const [activityHidden, setActivityHidden] = useState(false);
  const referenceTarget = useRef<HostInstance | null>(null);
  const nativeParent = useRef<HostInstance | null>(null);
  const nativeTarget = useRef<HostInstance | null>(null);
  const reactTarget = useRef<HostInstance | null>(null);
  const activityTarget = useRef<HostInstance | null>(null);
  const [status, setStatus] = useState('running');

  useEffect(() => {
    const run = async () => {
      await frames(10);
      setActivityHidden(true);
      await frames(10);
      await wait(300);
      // Change something inside every hidden container, with React.
      setLabel('changed');
      await frames(10);
      await wait(500);
      // Non-React commits into the hidden containers.
      const targets = [nativeTarget, reactTarget, activityTarget];
      for (let i = 0; i < 30; i++) {
        await nextFrame();
        for (const target of targets) {
          target.current?.setNativeProps({
            style: { backgroundColor: COLORS[i % COLORS.length] },
          });
        }
      }
      for (const target of [referenceTarget, ...targets]) {
        target.current?.setNativeProps({
          style: { backgroundColor: FINAL_COLOR },
        });
      }
      await frames(5);
      // Show them again: one without React, two with React.
      nativeParent.current?.setNativeProps({ style: { display: 'flex' } });
      setReactHidden(false);
      setActivityHidden(false);
      await frames(10);
      setStatus('done');
    };
    run();
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <Text>
          Un-hide check: {status}. Every row should have the same layout.
        </Text>
        <Text>Reference (never hidden)</Text>
        <View style={styles.box}>
          <View ref={referenceTarget} style={styles.target} />
          <Text>changed</Text>
        </View>
        <Text>Shown with setNativeProps</Text>
        <View ref={nativeParent} style={[styles.box, HIDE]}>
          <View ref={nativeTarget} style={styles.target} />
          <Text>{label}</Text>
        </View>
        <Text>Shown with React</Text>
        <View style={[styles.box, reactHidden && HIDE]}>
          <View ref={reactTarget} style={styles.target} />
          <Text>{label}</Text>
        </View>
        <Text>Activity, shown with React (keeps its initial color)</Text>
        <Activity mode={activityHidden ? 'hidden' : 'visible'}>
          <View style={styles.box}>
            <View ref={keep(activityTarget)} style={styles.target} />
            <Text>{label}</Text>
          </View>
        </Activity>
      </View>
      <ScrollView style={styles.list}>
        <Rows count={ROW_COUNT} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60, backgroundColor: 'white' },
  controls: { gap: 8, padding: 16 },
  result: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
  },
  stage: { height: 120, paddingHorizontal: 16 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#999',
  },
  invisible: { opacity: 0 },
  target: { width: 80, height: 40, backgroundColor: COLORS[0] },
  smallList: { height: 60, width: 120 },
  image: { width: 40, height: 40 },
  input: { width: 60, borderWidth: 1, borderColor: '#ccc' },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
  },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#ddd' },
  rowText: { flex: 1 },
  subtitle: { color: '#888' },
});

export default App;
