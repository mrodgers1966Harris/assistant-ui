import { describe, expect, it } from "vitest";
import {
  appendText,
  Gorp,
  type GorpMessage,
  type GorpOperation,
} from "../src/Gorp";
import { GorpClient } from "../src/GorpClient";
import { GorpRelay } from "../src/GorpRelay";
import { GorpServer } from "../src/GorpServer";
import { GorpSessions } from "../src/GorpSessions";

/**
 * Array indexes written by a remote operation, or by a proxy assignment that
 * publishes one, must be safe integers in range. These tests fail until that
 * bound exists: `deepApply` does `copy[Number(segment)] = …`, which sets
 * `length` to the index plus one, and the next copy walks that length.
 *
 * Allowed: `0 .. length` (replace or append one element). `length + 1` is the
 * last index the remediation permits (a single hole). Anything greater, any
 * negative, and any non-safe-integer must be rejected with the array unchanged.
 * Rejection has to happen before the write: a throw after the length changes
 * still fails.
 */

type State = { items: string[] };

const ORIGINAL = ["a", "b"] as const;

/**
 * Segments `Number()` will turn into an index that must not be written onto
 * an array of length 2. Includes the coercions the current write already
 * performs (`1e8`, `0x10`, leading `+`, trailing `.0`, whitespace).
 */
const REJECTED_SEGMENTS: readonly (readonly [string, string])[] = [
  ["one past the last permitted index", "4"],
  ["hundreds of millions", "100000000"],
  ["exponent form", "1e8"],
  ["uppercase exponent form", "1E8"],
  ["fractional spelling of a huge index", "100000000.0"],
  ["explicit plus", "+100000000"],
  ["hexadecimal", "0x10"],
  ["surrounding whitespace", "  4"],
  ["maximum array index", "4294967294"],
  ["negative", "-1"],
  ["fraction", "1.5"],
  ["infinity", "Infinity"],
  ["NaN", "NaN"],
  ["above the safe integer range", "1e21"],
  ["unsafe integer literal", "9007199254740993"],
];

function setOp(segment: string, rest: string[] = []): GorpOperation {
  const path = ["items", segment, ...rest];
  return { type: "set", path, value: "Z" };
}

function appendOp(segment: string, rest: string[] = []): GorpOperation {
  const path = ["items", segment, ...rest];
  return { type: "append-text", path, value: "Z" };
}

function operation(
  kind: "set" | "append-text",
  segment: string,
  rest: string[] = [],
): GorpOperation {
  return kind === "set" ? setOp(segment, rest) : appendOp(segment, rest);
}

/** True when a forwarded path segment would expand or pollute an array. */
function isDangerousSegment(segment: string): boolean {
  if (segment === "Infinity" || segment === "-Infinity" || segment === "NaN") {
    return true;
  }
  const index = Number(segment);
  if (!Number.isFinite(index)) return false;
  if (!Number.isSafeInteger(index)) return true;
  if (index < 0) return true;
  return index > ORIGINAL.length + 1;
}

function messageIsDangerous(message: GorpMessage): boolean {
  return message.ops.some((op) => op.path.some(isDangerousSegment));
}

function expectUnchanged(
  items: readonly string[],
  thrown: unknown,
  expected: readonly string[] = ORIGINAL,
) {
  // Length and own keys first. `Object.keys` does not walk holes, and a
  // failing length check must not spread the array (that walk is the DoS).
  expect(items.length).toBe(expected.length);
  expect(Object.keys(items)).toEqual(expected.map((_, index) => String(index)));
  expect(thrown).toBeInstanceOf(Error);
  if (Array.isArray(items) && items.length === expected.length) {
    expect([...items]).toEqual([...expected]);
  }
}

type Attempt = {
  thrown: unknown;
  items: readonly string[];
  dangerousForward: boolean;
};

function capture(run: () => void): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function attemptGorp(
  op: GorpOperation,
  items: string[] = [...ORIGINAL],
): Attempt {
  const gorp = new Gorp<State>({ items: [...items] });
  const thrown = capture(() => gorp.apply([op]));
  return {
    thrown,
    items: gorp.state.items,
    dangerousForward: false,
  };
}

function attemptClient(
  op: GorpOperation,
  items: string[] = [...ORIGINAL],
): Attempt {
  const client = new GorpClient<State, never>({
    initialState: { items: [...items] },
    mutator: () => {},
    send: () => {},
  });
  let dangerousForward = false;
  client.onChange(() => {
    const live = client.state.items as readonly string[];
    if (live.length > items.length || Object.keys(live).length > items.length) {
      dangerousForward = true;
    }
  });
  const thrown = capture(() => client.apply({ ops: [op] }));
  return { thrown, items: client.state.items as string[], dangerousForward };
}

function attemptRelay(
  op: GorpOperation,
  items: string[] = [...ORIGINAL],
): Attempt {
  const relay = new GorpRelay<State, never>({
    initialState: { items: [...items] },
    send: () => {},
  });
  let dangerousForward = false;
  relay.subscribe((message) => {
    if (messageIsDangerous(message)) dangerousForward = true;
  });
  const thrown = capture(() => relay.applyUpstream({ ops: [op] }));
  return { thrown, items: relay.state.items as string[], dangerousForward };
}

function attemptProxy(
  kind: "set" | "append-text",
  segment: string,
  items: string[] = [...ORIGINAL],
): Attempt {
  const gorp = new Gorp<State>({ items: [...items] });
  const thrown = capture(() => {
    const draft = gorp.draft(() => {});
    const list = draft.items as unknown as Record<string, string>;
    list[segment] = kind === "append-text" ? appendText("Z") : "Z";
  });
  return { thrown, items: gorp.state.items, dangerousForward: false };
}

async function attemptServer(
  kind: "set" | "append-text",
  segment: string,
  items: string[] = [...ORIGINAL],
): Promise<Attempt> {
  type Command = { index: string; kind: "set" | "append-text" };
  const server = new GorpServer<State, Command>({
    initialState: { items: [...items] },
    mutator: (state, command) => {
      const list = state.items as unknown as Record<string, string>;
      list[command.index] =
        command.kind === "append-text" ? appendText("Z") : "Z";
    },
  });
  const sessions = new GorpSessions(server);
  const inbox: GorpMessage[] = [];
  sessions.addClient("victim", 0, (message) => inbox.push(message));
  const snapshotCount = inbox.length;
  const thrown = capture(() => server.receive({ index: segment, kind }));
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  const forwarded = inbox.slice(snapshotCount);
  // A peer replica that applies whatever the session fans out.
  let dangerousForward = forwarded.some(messageIsDangerous);
  for (const message of forwarded) {
    const peer = new Gorp<State>({ items: [...items] });
    capture(() => peer.apply(message.ops));
    if (peer.state.items.length > items.length) dangerousForward = true;
  }
  return {
    thrown,
    items: server.state.items as string[],
    dangerousForward,
  };
}

const ENTRY_ATTEMPTS = [
  ["Gorp.apply", attemptGorp],
  ["GorpClient.apply", attemptClient],
  ["GorpRelay.applyUpstream", attemptRelay],
] as const;

describe("array index bounds", () => {
  describe("remote operations and proxy writes reject unbounded indexes", () => {
    const cases = (["set", "append-text"] as const).flatMap((kind) =>
      REJECTED_SEGMENTS.map(([label, segment]) => ({ kind, label, segment })),
    );

    it.each(cases)(
      "$kind rejects $label ($segment) before the array grows",
      async ({ kind, segment }) => {
        const op = operation(kind, segment);
        const failures: string[] = [];
        for (const [name, attempt] of ENTRY_ATTEMPTS) {
          try {
            const result = attempt(op);
            expectUnchanged(result.items, result.thrown);
            expect(result.dangerousForward).toBe(false);
          } catch (error) {
            failures.push(
              `${name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        try {
          const result = attemptProxy(kind, segment);
          expectUnchanged(result.items, result.thrown);
        } catch (error) {
          failures.push(
            `proxy set: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          const result = await attemptServer(kind, segment);
          expectUnchanged(result.items, result.thrown);
          expect(result.dangerousForward).toBe(false);
        } catch (error) {
          failures.push(
            `GorpServer.receive: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        expect(failures).toEqual([]);
      },
    );

    it.each(["set", "append-text"] as const)(
      "%s rejects a huge index on an intermediate path segment",
      (kind) => {
        const op = operation(kind, "100000000", ["child"]);
        const failures: string[] = [];
        for (const [name, attempt] of ENTRY_ATTEMPTS) {
          try {
            const result = attempt(op);
            expectUnchanged(result.items, result.thrown);
            expect(result.dangerousForward).toBe(false);
          } catch (error) {
            failures.push(
              `${name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        expect(failures).toEqual([]);
      },
    );

    it("rejects a huge index on an empty array", () => {
      const failures: string[] = [];
      for (const segment of ["2", "100000000", "1e8"]) {
        try {
          const result = attemptGorp(setOp(segment), []);
          expectUnchanged(result.items, result.thrown, []);
        } catch (error) {
          failures.push(
            `${segment}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });

    it("rejects a huge index that follows a same-batch write of the array", () => {
      const gorp = new Gorp<State>({ items: [] });
      const thrown = capture(() =>
        gorp.apply([
          { type: "set", path: ["items"], value: ["a", "b"] },
          setOp("100000000"),
        ]),
      );
      const items = gorp.state.items as string[];
      expect(items.length === 0 || items.length === ORIGINAL.length).toBe(true);
      expect(thrown).toBeInstanceOf(Error);
      if (items.length === ORIGINAL.length) {
        expect([...items]).toEqual([...ORIGINAL]);
      }
    });

    it("rejects a huge index after a sibling write in the same batch", () => {
      const gorp = new Gorp<State & { title: string }>({
        title: "doc",
        items: ["a", "b"],
      });
      const thrown = capture(() =>
        gorp.apply([
          { type: "set", path: ["title"], value: "updated" },
          setOp("100000000"),
        ]),
      );
      expect(["doc", "updated"]).toContain(gorp.state.title);
      expectUnchanged(gorp.state.items, thrown);
    });

    it("a peer command that assigns an attacker-chosen index does not grow any replica", async () => {
      type Command = { index: string };
      const mutator = (state: State, command: Command) => {
        const list = state.items as unknown as Record<string, string>;
        list[command.index] = "Z";
      };
      const server = new GorpServer<State, Command>({
        initialState: { items: ["a", "b"] },
        mutator,
      });
      const sessions = new GorpSessions(server);
      const victim = new GorpClient<State, Command>({
        initialState: { items: ["a", "b"] },
        mutator: () => {},
        send: () => {},
      });
      // Drop the initial snapshot. It aliases the server proxy; the test
      // applies only the ops a peer command publishes afterward.
      let primed = false;
      const victimHandle = sessions.addClient("victim", 0, (message) => {
        if (!primed) {
          primed = true;
          return;
        }
        victim.apply(message);
      });
      const attacker = new GorpClient<State, Command>({
        initialState: { items: ["a", "b"] },
        mutator,
        send: (command) => victimHandle.receive(command),
      });

      const thrown = capture(() => attacker.send({ index: "100000000" }));
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      expect((attacker.state.items as string[]).length).toBe(ORIGINAL.length);
      expect((server.state.items as string[]).length).toBe(ORIGINAL.length);
      expect((victim.state.items as string[]).length).toBe(ORIGINAL.length);
      expect(thrown).toBeInstanceOf(Error);
      expectUnchanged(attacker.state.items as string[], thrown);
      expectUnchanged(server.state.items as string[], thrown);
      expectUnchanged(victim.state.items as string[], thrown);
    });
  });

  describe("in-range indexes and object keys still apply", () => {
    it.each(["set", "append-text"] as const)(
      "%s replaces an existing element and appends at length",
      (kind) => {
        for (const [name, attempt] of ENTRY_ATTEMPTS) {
          const replaced = attempt(operation(kind, "1"));
          expect(replaced.thrown, name).toBeUndefined();
          expect(replaced.dangerousForward, name).toBe(false);
          expect([...(replaced.items as string[])]).toEqual(
            kind === "set" ? ["a", "Z"] : ["a", "bZ"],
          );

          const appended = attempt(operation(kind, "2"));
          expect(appended.thrown, name).toBeUndefined();
          expect([...(appended.items as string[])]).toEqual(["a", "b", "Z"]);
        }
      },
    );

    it("proxy assignment still replaces and appends", () => {
      const replaced = attemptProxy("set", "1");
      expect(replaced.thrown).toBeUndefined();
      expect([...(replaced.items as string[])]).toEqual(["a", "Z"]);

      const appended = attemptProxy("append-text", "2");
      expect(appended.thrown).toBeUndefined();
      expect([...(appended.items as string[])]).toEqual(["a", "b", "Z"]);
    });

    it("server mutator assignment still replaces an in-range index", async () => {
      const result = await attemptServer("set", "1");
      expect(result.thrown).toBeUndefined();
      expect(result.dangerousForward).toBe(false);
      expect(result.items.length).toBe(2);
      expect(result.items[0]).toBe("a");
      expect(result.items[1]).toBe("Z");
      expect(Object.keys(result.items)).toEqual(["0", "1"]);
    });

    it("a large numeric key on an object does not go through the array bound", () => {
      const gorp = new Gorp<{ bag: Record<string, number> }>({ bag: { a: 1 } });
      gorp.apply([{ type: "set", path: ["bag", "100000000"], value: 5 }]);
      expect(gorp.state.bag["100000000"]).toBe(5);
      expect(gorp.state.bag.a).toBe(1);
      expect(Object.keys(gorp.state.bag).sort()).toEqual(["100000000", "a"]);
    });
  });
});
