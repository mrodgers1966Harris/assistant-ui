import { cleanup, render } from "@testing-library/react";
import { TextMessagePartProvider } from "@assistant-ui/react";
import remend from "remend";
import { afterEach, describe, expect, it } from "vitest";
import { StreamdownTextPrimitive } from "../primitives/StreamdownText";
import { findRemendWindowStart, tailBoundedRemend } from "../remend";

afterEach(cleanup);

// 4x input. A single prefix scan per marker is ~16x slower; one pass is ~4x.
const GROWTH = 4;
const MAX_RATIO = 10;

function elapsed(work: () => void): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

/**
 * Fail when `work(4n)` takes about GROWTH^2 as long as `work(n)`.
 * Repeats the smaller input until it has a stable sample so a linear
 * implementation (a few milliseconds) is not judged on timer noise.
 * Each size is measured twice and the faster sample is kept, so one GC
 * pause cannot hide quadratic growth or fail a linear implementation.
 */
function expectLinearGrowth(
  label: string,
  work: (units: number) => void,
  units: number,
): void {
  work(8);

  const sample = (n: number, reps: number) =>
    elapsed(() => {
      for (let i = 0; i < reps; i += 1) work(n);
    });

  let reps = 1;
  let small = sample(units, reps);
  while (small < 40 && reps < 40) {
    reps += 1;
    small = sample(units, reps);
  }
  // Keep the faster sample so a GC pause on the short input cannot hide
  // quadratic growth, and a pause on the long input cannot fail a linear one.
  small = Math.min(small, sample(units, reps));

  const largeOnce = () => sample(units * GROWTH, reps);
  const large = Math.min(largeOnce(), largeOnce());
  const ratio = large / small;

  expect(
    ratio,
    `${label}: ${reps} x ${units} = ${small.toFixed(1)}ms, ${reps} x ${units * GROWTH} = ${large.toFixed(1)}ms`,
  ).toBeLessThan(MAX_RATIO);
}

describe("tailBoundedRemend quadratic repair", { timeout: 30_000 }, () => {
  it("passes a block with no blank line to remend in full", () => {
    const text = "a~".repeat(32);
    expect(findRemendWindowStart(text)).toBe(0);
    expect(tailBoundedRemend(text)).toBe(remend(text));
  });

  it("repairs a streamed block of letter-tilde pairs in one pass", () => {
    expectLinearGrowth(
      "single tilde",
      (units) => {
        const text = "a~".repeat(units);
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      4_000,
    );
  });

  it("repairs a long last block after a blank line in one pass", () => {
    expectLinearGrowth(
      "tilde tail",
      (units) => {
        const text = `intro\n\n${"a~".repeat(units)}`;
        expect(findRemendWindowStart(text)).toBeGreaterThan(0);
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      4_000,
    );
  });

  it("repairs each longer streaming prefix in one pass", () => {
    const once = () => {
      const times: number[] = [];
      let text = "";
      for (let step = 0; step < GROWTH; step += 1) {
        text += "a~".repeat(3_000);
        times.push(
          elapsed(() => {
            expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
          }),
        );
      }
      return times;
    };

    let times = once();
    let reps = 1;
    while ((times[0] ?? 0) < 40 && reps < 40) {
      const more = once();
      times = times.map((ms, index) => ms + (more[index] ?? 0));
      reps += 1;
    }

    const first = times[0] ?? 0;
    const last = times[times.length - 1] ?? 0;
    expect(
      last / first,
      times.map((ms) => `${ms.toFixed(1)}ms`).join(", "),
    ).toBeLessThan(MAX_RATIO);
  });

  it("repairs emphasis marks followed by a dollar sign in one pass", () => {
    expectLinearGrowth(
      "asterisk emphasis",
      (units) => {
        const text = `${"*a".repeat(units)}$`;
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      5_000,
    );
  });

  it("repairs word-internal asterisks in one pass", () => {
    expectLinearGrowth(
      "word-internal asterisks",
      (units) => {
        const text = "a*".repeat(units);
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      5_000,
    );
  });

  it("repairs underscore emphasis followed by a dollar sign in one pass", () => {
    expectLinearGrowth(
      "underscore emphasis",
      (units) => {
        const text = `${"_a".repeat(units)}$`;
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      3_000,
    );
  });

  it("repairs word-internal underscores in one pass", () => {
    expectLinearGrowth(
      "word-internal underscores",
      (units) => {
        const text = "a_".repeat(units);
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      4_000,
    );
  });

  it("repairs comparison operators in one pass", () => {
    const sample = "- > 1\n".repeat(30);
    expect(sample.includes("\n\n")).toBe(false);
    expect(findRemendWindowStart(sample)).toBe(0);

    expectLinearGrowth(
      "comparison operators",
      (units) => {
        const text = "- > 1\n".repeat(units);
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      2_000,
    );
  });

  it("repairs brackets inside an unclosed fence in one pass", () => {
    expectLinearGrowth(
      "links in fence",
      (units) => {
        const text = `\`\`\`\n${"a[".repeat(units)}`;
        expect(findRemendWindowStart(text)).toBe(0);
        expect(tailBoundedRemend(text).length).toBeGreaterThan(0);
      },
      2_000,
    );
  });
});

describe(
  "StreamdownTextPrimitive quadratic repair",
  { timeout: 30_000 },
  () => {
    it("repairs the message text in default streaming mode in one pass", () => {
      expectLinearGrowth(
        "primitive",
        (units) => {
          const view = render(
            <TextMessagePartProvider text={"a~".repeat(units)} isRunning>
              <StreamdownTextPrimitive />
            </TextMessagePartProvider>,
          );
          expect(view.container.textContent?.length).toBeGreaterThan(0);
          view.unmount();
        },
        4_000,
      );
    });

    it("repairs through streamdown when a custom block parser is set", () => {
      let received = "";
      const view = render(
        <TextMessagePartProvider text="20~25" isRunning>
          <StreamdownTextPrimitive
            parseMarkdownIntoBlocksFn={(markdown) => {
              received = markdown;
              return [];
            }}
          />
        </TextMessagePartProvider>,
      );
      view.unmount();
      expect(received).toBe(remend("20~25"));

      expectLinearGrowth(
        "custom block parser",
        (units) => {
          const view = render(
            <TextMessagePartProvider text={"a~".repeat(units)} isRunning>
              <StreamdownTextPrimitive
                parseMarkdownIntoBlocksFn={(markdown) => {
                  expect(markdown.length).toBeGreaterThan(0);
                  return [];
                }}
              />
            </TextMessagePartProvider>,
          );
          view.unmount();
        },
        4_000,
      );
    });
  },
);
