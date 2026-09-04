// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import plugin, {
  createGoalModePlugin,
  createGoalState,
  formatGoalStatus,
  goalContract,
  parseGoalCommand,
} from "../src/index.js";

function mockContext(options = {}) {
  const storage = new Map();
  const commands = [];
  const tools = [];
  const hooks = new Map();
  const prompts = [];
  const synthetic = [];
  const registration = () => ({ dispose: async () => {} });

  const context = {
    options,
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => {
        storage.set(key, value);
      },
      remove: async (key) => {
        storage.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => commands.push(definition) });
        return registration();
      },
    },
    tool: {
      transform: async (callback) => {
        callback({
          namespace() {},
          add: (definition) => tools.push(definition),
          list: () => tools,
          get: () => undefined,
          update() {},
          remove() {},
        });
        return registration();
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback);
        return registration();
      },
      prompt: async (input) => {
        prompts.push(input);
        return {};
      },
      synthetic: async (input) => {
        synthetic.push(input);
        return {};
      },
      interrupt: async () => {},
    },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          if (!signal?.aborted) {
            await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
          }
        },
      }),
    },
  };

  return { context, storage, commands, tools, hooks, prompts, synthetic };
}

test("parses the complete /goal command surface", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" });
  assert.deepEqual(parseGoalCommand("/goal status"), { action: "status" });
  assert.deepEqual(parseGoalCommand("pause"), { action: "pause" });
  assert.deepEqual(parseGoalCommand("off"), { action: "clear" });
  assert.deepEqual(parseGoalCommand("edit ship the safe fix"), {
    action: "edit",
    objective: "ship the safe fix",
  });
  assert.deepEqual(parseGoalCommand("ship the safe fix"), {
    action: "start",
    objective: "ship the safe fix",
  });
});

test("formats a durable state and active contract", () => {
  const goal = createGoalState("finish and verify the feature", 7);
  assert.match(goal.id, /^goal_/);
  assert.match(formatGoalStatus(goal), /Automatic turns: 0\/7/);
  assert.match(goalContract(goal), new RegExp(`Goal ID: ${goal.id}`));
  assert.match(goalContract(goal), /goal_complete/);
});

test("registers /goal through the current add-only command API", async () => {
  const mock = mockContext({ auto_continue: false });
  const cleanup = await plugin.setup(/** @type {any} */ (mock.context));

  assert.equal(plugin.id, "phall1.goal-mode");
  assert.deepEqual(mock.commands.map((command) => command.name), ["goal"]);
  assert.deepEqual(mock.tools.map((tool) => `goal_${tool.name}`), ["goal_status", "goal_complete", "goal_blocked"]);

  await mock.commands[0].execute({
    sessionID: "ses_test",
    prompt: { text: "status" },
    delivery: "steer",
  });
  assert.match(mock.synthetic[0].text, /no goal/);

  await mock.commands[0].execute({
    sessionID: "ses_test",
    prompt: { text: "finish and verify the feature" },
    delivery: "steer",
  });
  assert.equal(mock.prompts.length, 1);
  assert.match(mock.prompts[0].text, /finish and verify the feature/);

  const stored = mock.storage.get("goal/ses_test");
  assert.equal(stored.status, "active");

  await cleanup?.();
});

test("injects the active contract and enforces exact completion IDs", async () => {
  const mock = mockContext({ auto_continue: false });
  const cleanup = await plugin.setup(/** @type {any} */ (mock.context));
  await mock.commands[0].execute({
    sessionID: "ses_test",
    prompt: { text: "verify everything" },
    delivery: "steer",
  });
  const goal = mock.storage.get("goal/ses_test");
  const contextHook = mock.hooks.get("context");
  const event = { sessionID: "ses_test", agent: "build", system: [], messages: [], tools: {}, generation: {}, providerOptions: {} };
  await contextHook(event);
  assert.match(event.system[0].text, new RegExp(goal.id));

  const complete = mock.tools.find((tool) => tool.name === "complete");
  await assert.rejects(
    complete.execute({ goal_id: "goal_stale", evidence: "All tests passed and artifacts were inspected." }, { sessionID: "ses_test" }),
    /Stale goal_id/,
  );
  const result = await complete.execute(
    { goal_id: goal.id, evidence: "All tests passed and artifacts were inspected." },
    { sessionID: "ses_test" },
  );
  assert.match(result.content, /Goal mode: complete/);
  assert.equal(mock.storage.get("goal/ses_test").status, "complete");

  await cleanup?.();
});

test("never writes undefined values into JSON plugin storage", async () => {
  const mock = mockContext({ auto_continue: false });
  const runtime = createGoalModePlugin(/** @type {any} */ (mock.context));
  const stored = await runtime.writeGoal("ses_json", {
    ...createGoalState("keep storage valid"),
    stopReason: undefined,
  });

  assert.equal(Object.hasOwn(stored, "stopReason"), false);
  assert.equal(JSON.stringify(stored).includes("undefined"), false);
  runtime.dispose();
});

test("auto-continuation queues one bounded follow-up", async () => {
  const mock = mockContext({ max_automatic_turns: 2, min_continue_interval_ms: 0 });
  const runtime = createGoalModePlugin(/** @type {any} */ (mock.context));
  await runtime.writeGoal("ses_auto", createGoalState("complete the task", 2));

  runtime.scheduleContinuation("ses_auto");
  runtime.scheduleContinuation("ses_auto");
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(mock.prompts.length, 1);
  assert.match(mock.prompts[0].text, /Automatic continuation 1\/2/);
  assert.equal(mock.storage.get("goal/ses_auto").automaticTurns, 1);
  runtime.dispose();
});
