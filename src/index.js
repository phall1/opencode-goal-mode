// @ts-check

/** @typedef {import("@opencode/plugin").Plugin.Context} PluginContext */
/** @typedef {import("@opencode/plugin/promise/command").CommandInvocation} CommandInvocation */
/** @typedef {import("@opencode/plugin/promise/registration").Registration} Registration */

const STATE_VERSION = 1;
const DEFAULT_MAX_AUTOMATIC_TURNS = 25;
const DEFAULT_MAX_PROMPT_FAILURES = 3;
const DEFAULT_MIN_CONTINUE_INTERVAL_MS = 2_000;
const MAX_OBJECTIVE_LENGTH = 4_000;

/**
 * @typedef {"active" | "paused" | "blocked" | "complete"} GoalStatus
 * @typedef {{
 *   version: number,
 *   id: string,
 *   objective: string,
 *   status: GoalStatus,
 *   automaticTurns: number,
 *   maxAutomaticTurns: number,
 *   promptFailures: number,
 *   createdAt: string,
 *   updatedAt: string,
 *   lastContinuationAt?: number,
 *   evidence?: string,
 *   blocker?: string,
 *   stopReason?: string,
 * }} GoalState
 * @typedef {{action: "status" | "start" | "edit" | "pause" | "resume" | "clear", objective?: string}} GoalCommand
 */

/** @param {unknown} value @param {number} fallback */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/** @param {unknown} value @param {number} fallback */
function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

/** @param {string} sessionID */
function stateKey(sessionID) {
  return `goal/${sessionID}`;
}

function now() {
  return new Date().toISOString();
}

function goalID() {
  return `goal_${globalThis.crypto.randomUUID()}`;
}

/** @param {unknown} value */
function isGoalState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const goal = /** @type {Record<string, unknown>} */ (value);
  return (
    goal.version === STATE_VERSION &&
    typeof goal.id === "string" &&
    typeof goal.objective === "string" &&
    ["active", "paused", "blocked", "complete"].includes(String(goal.status)) &&
    Number.isSafeInteger(goal.automaticTurns) &&
    Number.isSafeInteger(goal.maxAutomaticTurns) &&
    Number.isSafeInteger(goal.promptFailures)
  );
}

/** @param {string} raw */
export function parseGoalCommand(raw) {
  const text = raw.trim().replace(/^\/goal(?:\s+|$)/i, "").trim();
  if (!text || /^status$/i.test(text)) return /** @type {GoalCommand} */ ({ action: "status" });
  if (/^(pause)$/i.test(text)) return /** @type {GoalCommand} */ ({ action: "pause" });
  if (/^(resume)$/i.test(text)) return /** @type {GoalCommand} */ ({ action: "resume" });
  if (/^(clear|cancel|off|reset|stop|none)$/i.test(text)) return /** @type {GoalCommand} */ ({ action: "clear" });

  const edit = text.match(/^edit(?:\s+([\s\S]+))?$/i);
  if (edit) return /** @type {GoalCommand} */ ({ action: "edit", objective: edit[1]?.trim() ?? "" });

  return /** @type {GoalCommand} */ ({ action: "start", objective: text });
}

/** @param {string} objective @param {number} maxAutomaticTurns */
export function createGoalState(objective, maxAutomaticTurns = DEFAULT_MAX_AUTOMATIC_TURNS) {
  const timestamp = now();
  return /** @type {GoalState} */ ({
    version: STATE_VERSION,
    id: goalID(),
    objective,
    status: "active",
    automaticTurns: 0,
    maxAutomaticTurns,
    promptFailures: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** @param {GoalState | undefined} goal */
export function formatGoalStatus(goal) {
  if (!goal) return "Goal mode: no goal. Start one with /goal <objective>.";
  const lines = [
    `Goal mode: ${goal.status}`,
    `ID: ${goal.id}`,
    `Objective: ${goal.objective}`,
    `Automatic turns: ${goal.automaticTurns}/${goal.maxAutomaticTurns}`,
  ];
  if (goal.stopReason) lines.push(`Stopped because: ${goal.stopReason}`);
  if (goal.evidence) lines.push(`Evidence: ${goal.evidence}`);
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`);
  return lines.join("\n");
}

/** @param {GoalState} goal */
export function goalContract(goal) {
  return [
    "## Goal Mode (ACTIVE)",
    `Goal ID: ${goal.id}`,
    `Objective: ${goal.objective}`,
    "",
    "Keep working toward the complete objective across turns. Treat repository state, command output, tests, and external state as authoritative evidence.",
    "Do not narrow or expand the objective. User, developer, repository, permission, and selected-agent instructions remain higher priority.",
    "Before declaring success, audit every objective requirement and run verification with scope matching the claim.",
    `Call goal_complete with goal_id=${goal.id} and concrete evidence only when the whole objective is proven complete.`,
    `Call goal_blocked with goal_id=${goal.id}, a specific blocker, and attempted-resolution evidence only when progress genuinely requires user or external action.`,
    "Do not stop merely after explaining a plan. Continue implementation and verification until a terminal goal tool is accepted.",
  ].join("\n");
}

/** @param {GoalState} goal */
function kickoffPrompt(goal) {
  return [
    "Goal mode has started.",
    `<goal_id>${goal.id}</goal_id>`,
    "<objective>",
    goal.objective,
    "</objective>",
    "Begin or continue the work now. Preserve the full objective across turns and use goal_complete or goal_blocked only under the active Goal Mode contract.",
  ].join("\n");
}

/** @param {GoalState} goal */
function continuationPrompt(goal) {
  return [
    "Continue the active goal. Do not merely recap or stop at a plan.",
    `<goal_id>${goal.id}</goal_id>`,
    "<objective>",
    goal.objective,
    "</objective>",
    `Automatic continuation ${goal.automaticTurns}/${goal.maxAutomaticTurns}.`,
    "Inspect current state, perform the next required work, verify it, and call a terminal goal tool only when its evidence requirements are satisfied.",
  ].join("\n");
}

/** @param {unknown} value @param {string} field */
function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

/** @param {string} objective */
function validateObjective(objective) {
  const value = requiredText(objective, "objective");
  if (value.length > MAX_OBJECTIVE_LENGTH) throw new Error(`objective must be at most ${MAX_OBJECTIVE_LENGTH} characters.`);
  return value;
}

/** @param {unknown} input */
function eventSession(input) {
  if (!input || typeof input !== "object") return undefined;
  const event = /** @type {{type?: unknown, data?: unknown}} */ (input);
  if (!event.data || typeof event.data !== "object") return undefined;
  const sessionID = /** @type {{sessionID?: unknown}} */ (event.data).sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}

/** @param {unknown} input */
function isSettledEvent(input) {
  if (!input || typeof input !== "object") return false;
  const event = /** @type {{type?: unknown, data?: unknown}} */ (input);
  if (event.type === "session.idle") return true;
  if (event.type !== "session.status" || !event.data || typeof event.data !== "object") return false;
  const status = /** @type {{status?: unknown}} */ (event.data).status;
  return Boolean(status && typeof status === "object" && /** @type {{type?: unknown}} */ (status).type === "idle");
}

/** @param {PluginContext} ctx */
export function createGoalModePlugin(ctx) {
  const options = /** @type {Record<string, unknown>} */ (ctx.options ?? {});
  const autoContinue = options.auto_continue !== false;
  const maxAutomaticTurns = positiveInteger(options.max_automatic_turns, DEFAULT_MAX_AUTOMATIC_TURNS);
  const maxPromptFailures = positiveInteger(options.max_prompt_failures, DEFAULT_MAX_PROMPT_FAILURES);
  const minContinueIntervalMs = nonNegativeInteger(
    options.min_continue_interval_ms,
    DEFAULT_MIN_CONTINUE_INTERVAL_MS,
  );
  /** @type {Map<string, Promise<unknown>>} */
  const locks = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const scheduled = new Map();
  const continuing = new Set();
  let disposed = false;

  /** @template T @param {string} sessionID @param {() => Promise<T>} work @returns {Promise<T>} */
  async function withLock(sessionID, work) {
    const previous = locks.get(sessionID) ?? Promise.resolve();
    /** @type {(value: undefined) => void} */
    let release = () => {};
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    locks.set(sessionID, queued);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release(undefined);
      if (locks.get(sessionID) === queued) locks.delete(sessionID);
    }
  }

  /** @param {string} sessionID */
  async function readGoal(sessionID) {
    const value = await ctx.storage.get(stateKey(sessionID));
    return isGoalState(value) ? /** @type {GoalState} */ (value) : undefined;
  }

  /** @param {string} sessionID @param {GoalState} goal */
  async function writeGoal(sessionID, goal) {
    const stored = /** @type {GoalState} */ (JSON.parse(JSON.stringify(goal)));
    await ctx.storage.set(stateKey(sessionID), stored);
    return stored;
  }

  /** @param {string} sessionID @param {string} message */
  async function notify(sessionID, message) {
    await ctx.session.synthetic({ sessionID, text: message });
  }

  /** @param {string} sessionID */
  function cancelScheduled(sessionID) {
    const timer = scheduled.get(sessionID);
    if (timer) clearTimeout(timer);
    scheduled.delete(sessionID);
  }

  /** @param {string} sessionID */
  async function continueGoal(sessionID) {
    if (disposed || continuing.has(sessionID)) return;
    continuing.add(sessionID);
    try {
      const reserved = await withLock(sessionID, async () => {
        const goal = await readGoal(sessionID);
        if (!goal || goal.status !== "active") return undefined;
        const currentTime = Date.now();
        if (goal.lastContinuationAt && currentTime - goal.lastContinuationAt < minContinueIntervalMs) return undefined;
        if (goal.automaticTurns >= goal.maxAutomaticTurns) {
          const paused = await writeGoal(sessionID, {
            ...goal,
            status: "paused",
            stopReason: `automatic turn limit ${goal.maxAutomaticTurns}/${goal.maxAutomaticTurns}`,
            updatedAt: now(),
          });
          await notify(sessionID, formatGoalStatus(paused));
          return undefined;
        }
        return writeGoal(sessionID, {
          ...goal,
          automaticTurns: goal.automaticTurns + 1,
          lastContinuationAt: currentTime,
          updatedAt: now(),
        });
      });
      if (!reserved) return;

      try {
        await ctx.session.prompt({
          sessionID,
          text: continuationPrompt(reserved),
          delivery: "queue",
        });
      } catch (error) {
        await withLock(sessionID, async () => {
          const current = await readGoal(sessionID);
          if (!current || current.id !== reserved.id || current.status !== "active") return;
          const failures = current.promptFailures + 1;
          await writeGoal(sessionID, {
            ...current,
            automaticTurns: Math.max(0, current.automaticTurns - 1),
            promptFailures: failures,
            status: failures >= maxPromptFailures ? "paused" : "active",
            stopReason: failures >= maxPromptFailures ? `continuation delivery failed ${failures} times` : current.stopReason,
            updatedAt: now(),
          });
        });
        console.error("[opencode-goal-mode] continuation failed", error);
      }
    } finally {
      continuing.delete(sessionID);
    }
  }

  /** @param {string} sessionID */
  function scheduleContinuation(sessionID) {
    if (!autoContinue || disposed || scheduled.has(sessionID)) return;
    const timer = setTimeout(() => {
      scheduled.delete(sessionID);
      void continueGoal(sessionID);
    }, 100);
    timer.unref?.();
    scheduled.set(sessionID, timer);
  }

  /** @param {CommandInvocation} invocation */
  async function executeCommand(invocation) {
    const command = parseGoalCommand(invocation.prompt.text);
    const { sessionID } = invocation;

    if (command.action === "status") {
      await notify(sessionID, formatGoalStatus(await readGoal(sessionID)));
      return;
    }

    if (command.action === "clear") {
      cancelScheduled(sessionID);
      await ctx.storage.remove(stateKey(sessionID));
      await notify(sessionID, "Goal mode cleared.");
      return;
    }

    if (command.action === "pause") {
      cancelScheduled(sessionID);
      const goal = await withLock(sessionID, async () => {
        const current = await readGoal(sessionID);
        if (!current) throw new Error("No goal exists to pause.");
        if (current.status !== "active") throw new Error(`Goal is ${current.status}, not active.`);
        return writeGoal(sessionID, { ...current, status: "paused", stopReason: "paused by user", updatedAt: now() });
      });
      await ctx.session.interrupt({ sessionID }).catch(() => undefined);
      await notify(sessionID, formatGoalStatus(goal));
      return;
    }

    if (command.action === "resume") {
      const goal = await withLock(sessionID, async () => {
        const current = await readGoal(sessionID);
        if (!current) throw new Error("No goal exists to resume.");
        if (current.status === "complete") throw new Error("Completed goals cannot be resumed; start a new goal.");
        return writeGoal(sessionID, {
          ...current,
          status: "active",
          automaticTurns: 0,
          promptFailures: 0,
          stopReason: undefined,
          updatedAt: now(),
        });
      });
      await ctx.session.prompt({ ...invocation.prompt, sessionID, text: kickoffPrompt(goal), delivery: invocation.delivery });
      return;
    }

    const objective = validateObjective(command.objective ?? "");
    const goal = await withLock(sessionID, async () => {
      if (command.action === "edit") {
        const current = await readGoal(sessionID);
        if (!current) throw new Error("No goal exists to edit.");
        return writeGoal(sessionID, {
          ...current,
          id: goalID(),
          objective,
          status: "active",
          automaticTurns: 0,
          promptFailures: 0,
          stopReason: undefined,
          evidence: undefined,
          blocker: undefined,
          updatedAt: now(),
        });
      }
      return writeGoal(sessionID, createGoalState(objective, maxAutomaticTurns));
    });
    await ctx.session.prompt({ ...invocation.prompt, sessionID, text: kickoffPrompt(goal), delivery: invocation.delivery });
  }

  return {
    readGoal,
    writeGoal,
    executeCommand,
    scheduleContinuation,
    cancelScheduled,
    dispose() {
      disposed = true;
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    },
  };
}

export default {
  id: "phall1.goal-mode",
  /** @param {PluginContext} ctx */
  async setup(ctx) {
    const runtime = createGoalModePlugin(ctx);
    /** @type {Registration[]} */
    const registrations = [];

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "goal",
          description: "Start or manage a durable autonomous goal",
          execute: runtime.executeCommand,
        });
      }),
    );

    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "goal", description: "Manage the active durable session goal." });
        editor.add({
          name: "status",
          description: "Read the current session goal and its lifecycle state.",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { namespace: "goal", codemode: false },
          async execute(_input, tool) {
            const goal = await runtime.readGoal(tool.sessionID);
            return { content: formatGoalStatus(goal) };
          },
        });
        editor.add({
          name: "complete",
          description: "Complete the exact active goal only after verifying the whole objective with concrete evidence.",
          input: {
            type: "object",
            properties: {
              goal_id: { type: "string", description: "Exact active goal ID from the Goal Mode contract." },
              evidence: { type: "string", description: "Concrete completion evidence, including checks and artifacts." },
            },
            required: ["goal_id", "evidence"],
            additionalProperties: false,
          },
          options: { namespace: "goal", codemode: false },
          async execute(input, tool) {
            const args = /** @type {{goal_id?: unknown, evidence?: unknown}} */ (input);
            const requestedID = requiredText(args.goal_id, "goal_id");
            const evidence = requiredText(args.evidence, "evidence");
            if (evidence.length < 20) throw new Error("evidence must be concrete and at least 20 characters.");
            const goal = await runtime.readGoal(tool.sessionID);
            if (!goal || goal.status !== "active") throw new Error("No active goal can be completed.");
            if (goal.id !== requestedID) throw new Error("Stale goal_id; read the current Goal Mode contract.");
            const complete = await runtime.writeGoal(tool.sessionID, {
              ...goal,
              status: "complete",
              evidence,
              updatedAt: now(),
            });
            runtime.cancelScheduled(tool.sessionID);
            return { content: formatGoalStatus(complete) };
          },
        });
        editor.add({
          name: "blocked",
          description: "Stop an exact active goal only for a genuine blocker requiring user or external action.",
          input: {
            type: "object",
            properties: {
              goal_id: { type: "string", description: "Exact active goal ID from the Goal Mode contract." },
              blocker: { type: "string", description: "Specific user or external action required." },
              evidence: { type: "string", description: "Resolution attempts and observed failures proving the blocker." },
            },
            required: ["goal_id", "blocker", "evidence"],
            additionalProperties: false,
          },
          options: { namespace: "goal", codemode: false },
          async execute(input, tool) {
            const args = /** @type {{goal_id?: unknown, blocker?: unknown, evidence?: unknown}} */ (input);
            const requestedID = requiredText(args.goal_id, "goal_id");
            const blocker = requiredText(args.blocker, "blocker");
            const evidence = requiredText(args.evidence, "evidence");
            const goal = await runtime.readGoal(tool.sessionID);
            if (!goal || goal.status !== "active") throw new Error("No active goal can be blocked.");
            if (goal.id !== requestedID) throw new Error("Stale goal_id; read the current Goal Mode contract.");
            const blocked = await runtime.writeGoal(tool.sessionID, {
              ...goal,
              status: "blocked",
              blocker: `${blocker}\nAttempts: ${evidence}`,
              updatedAt: now(),
            });
            runtime.cancelScheduled(tool.sessionID);
            return { content: formatGoalStatus(blocked) };
          },
        });
      }),
    );

    registrations.push(
      await ctx.session.hook("context", async (event) => {
        const goal = await runtime.readGoal(event.sessionID);
        if (!goal || goal.status !== "active") return;
        if (String(event.agent).toLowerCase() === "plan") {
          await runtime.writeGoal(event.sessionID, {
            ...goal,
            status: "paused",
            stopReason: "plan mode safety boundary; switch to Build and run /goal resume",
            updatedAt: now(),
          });
          return;
        }
        const contract = goalContract(goal);
        if (!event.system.some((part) => part.type === "text" && part.text.includes(`Goal ID: ${goal.id}`))) {
          event.system.push({ type: "text", text: contract });
        }
      }),
    );

    const abortController = new AbortController();
    const consumer = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
          const sessionID = eventSession(event);
          if (!sessionID) continue;
          if (isSettledEvent(event)) runtime.scheduleContinuation(sessionID);
          if (event.type === "session.deleted") {
            runtime.cancelScheduled(sessionID);
            await ctx.storage.remove(stateKey(sessionID));
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) console.error("[opencode-goal-mode] event stream stopped", error);
      }
    })();

    return async () => {
      abortController.abort();
      runtime.dispose();
      await Promise.allSettled(registrations.map((registration) => registration.dispose()));
      await consumer.catch(() => undefined);
    };
  },
};
