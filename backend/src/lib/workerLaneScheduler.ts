export interface WorkerLaneScheduler<Lane extends string> {
  start(): void;
  stop(): void;
  isBusy(): boolean;
  busyLanes(): Lane[];
}

interface WorkerLaneSchedulerOptions<Lane extends string> {
  lanes: readonly Lane[];
  idlePollMs: number;
  runLane: (lane: Lane) => Promise<boolean>;
  onError: (lane: Lane, error: unknown) => void;
}

interface LaneState {
  busy: boolean;
  timer?: NodeJS.Timeout;
}

export function createWorkerLaneScheduler<Lane extends string>({
  lanes,
  idlePollMs,
  runLane,
  onError,
}: WorkerLaneSchedulerOptions<Lane>): WorkerLaneScheduler<Lane> {
  const states = new Map<Lane, LaneState>(lanes.map((lane) => [lane, { busy: false }]));
  let started = false;
  let stopped = false;

  async function runPass(lane: Lane): Promise<void> {
    const state = states.get(lane);
    if (!state || stopped || state.busy) return;

    state.busy = true;
    let claimed = false;
    try {
      claimed = await runLane(lane);
    } catch (error) {
      onError(lane, error);
    } finally {
      state.busy = false;
    }

    if (stopped) return;
    state.timer = setTimeout(() => void runPass(lane), claimed ? 0 : idlePollMs);
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      for (const lane of states.keys()) void runPass(lane);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const state of states.values()) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    },
    isBusy() {
      return [...states.values()].some((state) => state.busy);
    },
    busyLanes() {
      return [...states.entries()].filter(([, state]) => state.busy).map(([lane]) => lane);
    },
  };
}
