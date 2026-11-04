import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Sparkline, TimeseriesChart, chartColors, statusClassColor } from "../src/charts";

afterEach(cleanup);

describe("charts", () => {
  test("chart colors are var() references to the chart tokens", () => {
    expect(chartColors.requests).toBe("var(--sb-chart-requests)");
    expect(chartColors.deploy).toBe("var(--sb-chart-deploy)");
    expect(statusClassColor("5xx")).toBe("var(--sb-chart-5xx)");
    expect(statusClassColor("1xx")).toBe("var(--sb-chart-other)");
  });

  test("TimeseriesChart renders a labelled chart with a deploy rule", () => {
    const { container } = render(
      <TimeseriesChart
        ariaLabel="Requests per minute"
        series={[
          {
            id: "req",
            label: "Requests",
            data: [
              { time: 0, value: 1 },
              { time: 1, value: 3 },
            ],
          },
        ]}
        deploy={{ time: 0.5, label: "v2" }}
      />,
    );
    expect(container.querySelector('[aria-label="Requests per minute"]')).not.toBeNull();
    expect(container.querySelector(".sb-chart")).not.toBeNull();
  });

  test("Sparkline renders a labelled chart", () => {
    const { container } = render(<Sparkline ariaLabel="Errors, last hour" data={[1, 2, 3]} color="errors" />);
    expect(container.querySelector('[aria-label="Errors, last hour"]')).not.toBeNull();
  });
});
