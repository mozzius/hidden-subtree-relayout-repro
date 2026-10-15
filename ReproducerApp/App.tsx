/**
 * Repro: every commit that touches anything inside a <Modal> re-runs Yoga
 * layout (and pixel-grid rounding) over the *whole* surface, even when the
 * commit changes nothing layout-related.
 *
 * ModalHostViewComponentDescriptor::adopt() calls
 * YogaLayoutableShadowNode::setSize() and setPositionType() on every clone of
 * the ModalHostView, and both unconditionally mark the Yoga node dirty. A
 * commit clones the path from the changed node to the root, so any update
 * under the Modal dirties the root.
 *
 * The main screen renders ROW_COUNT rows, so a full re-layout is expensive
 * enough to show up. There are two ways to trigger commits that change
 * nothing layout-related:
 *
 * 1. A background color change, once per frame, timed on screen:
 *   - "Run outside Modal": the ticker sits in the main screen
 *   - "Run inside Modal": the ticker sits inside a <Modal>
 *
 * 2. Scrolling, which commits a ScrollView contentOffset state update per
 *    scroll event. JS can't time these, so measure them with a profiler:
 *   - outside: scroll the main list
 *   - inside: "Open scroll Modal", then scroll the list inside it
 *
 * The color change is applied with setNativeProps, which commits straight to the
 * ShadowTree (ShadowNode::cloneTree + layout + mount) synchronously on the JS
 * thread, so each sample times exactly one ShadowTree commit. A React state
 * update can't show the difference: React's Fabric renderer clones every
 * ancestor with an empty child list and then calls appendChild, which always
 * dirties the ancestors, so every React commit lays out from the root anyway.
 * The commits that pay for the Modal bug are the ones that don't go through
 * React: state updates (e.g. scrolling a ScrollView inside the Modal),
 * setNativeProps, and animation libraries that commit to the ShadowTree.
 *
 * @format
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

/** Rows in the main screen. Layout cost scales with this. */
const ROW_COUNT = 1000;
/** Rows in the scroll Modal's list. */
const MODAL_ROW_COUNT = 60;
/** Color updates per run. */
const FRAME_COUNT = 120;
const COLORS = ['#f4cccc', '#d9ead3', '#cfe2f3', '#fff2cc'];

type Result = { median: number; p90: number; samples: number };

function summarize(samples: number[]): Result {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { median: at(0.5), p90: at(0.9), samples: sorted.length };
}

function formatResult(result: Result | undefined) {
  if (!result) {
    return '-';
  }
  return `median ${result.median.toFixed(2)} ms, p90 ${result.p90.toFixed(
    2,
  )} ms (n=${result.samples})`;
}

/**
 * Changes its own background color once per frame, FRAME_COUNT times, via
 * setNativeProps, and reports how long each ShadowTree commit took.
 */
function ColorTicker({ onDone }: { onDone: (result: Result) => void }) {
  const ref = useRef<React.ComponentRef<typeof View>>(null);

  useEffect(() => {
    const samples: number[] = [];
    let frame = 0;
    let id = 0;
    const tick = () => {
      if (frame >= FRAME_COUNT) {
        onDone(summarize(samples));
        return;
      }
      const start = performance.now();
      ref.current?.setNativeProps({
        style: { backgroundColor: COLORS[(frame + 1) % COLORS.length] },
      });
      samples.push(performance.now() - start);
      frame++;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [onDone]);

  return (
    <View ref={ref} style={[styles.ticker, { backgroundColor: COLORS[0] }]} />
  );
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

function App() {
  const [run, setRun] = useState<'outside' | 'inside' | null>(null);
  const [outside, setOutside] = useState<Result>();
  const [inside, setInside] = useState<Result>();
  const [scrollModalOpen, setScrollModalOpen] = useState(false);

  const onOutsideDone = (result: Result) => {
    setOutside(result);
    setRun(null);
  };
  const onInsideDone = (result: Result) => {
    setInside(result);
    setRun(null);
  };

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <Button
          title="Run outside Modal"
          disabled={run !== null}
          onPress={() => setRun('outside')}
        />
        <Button
          title="Run inside Modal"
          disabled={run !== null}
          onPress={() => setRun('inside')}
        />
        <Text testID="outside-result">
          Outside Modal: {formatResult(outside)}
        </Text>
        <Text testID="inside-result">Inside Modal: {formatResult(inside)}</Text>
        <Button
          title="Open scroll Modal"
          disabled={run !== null}
          onPress={() => setScrollModalOpen(true)}
        />
        {run === 'outside' && <ColorTicker onDone={onOutsideDone} />}
      </View>
      <ScrollView testID="main-list" style={styles.list}>
        <Rows count={ROW_COUNT} />
      </ScrollView>
      <Modal
        visible={run === 'inside'}
        transparent
        animationType="none"
        onRequestClose={() => {}}
      >
        <View style={styles.modal}>
          <Text>Running inside Modal…</Text>
          {run === 'inside' && <ColorTicker onDone={onInsideDone} />}
        </View>
      </Modal>
      <Modal
        visible={scrollModalOpen}
        transparent
        animationType="none"
        onRequestClose={() => setScrollModalOpen(false)}
      >
        <View style={styles.scrollModal}>
          <Button
            title="Close scroll Modal"
            onPress={() => setScrollModalOpen(false)}
          />
          <ScrollView testID="modal-list" style={styles.list}>
            <Rows count={MODAL_ROW_COUNT} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60, backgroundColor: 'white' },
  controls: { gap: 8, padding: 16 },
  ticker: { height: 40 },
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
  modal: {
    marginTop: 200,
    marginHorizontal: 32,
    padding: 16,
    gap: 8,
    borderRadius: 12,
    backgroundColor: 'white',
  },
  scrollModal: {
    flex: 1,
    marginTop: 300,
    marginBottom: 40,
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'white',
  },
});

export default App;
