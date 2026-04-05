import * as LaunchDarkly from "@launchdarkly/node-server-sdk";
import { Observability } from "@launchdarkly/observability-node";

const LD_SDK_KEY = process.env.LD_SDK_KEY;

export const ldClient = LD_SDK_KEY ? LaunchDarkly.init(LD_SDK_KEY, {
  plugins: [
    new Observability({
      serviceName: "hive",
      serviceVersion: "1.0.0",
      environment: "production",
      consoleMethodsToRecord: ["warn", "error"],
    }),
  ],
}) : null;

export const ldContext: LaunchDarkly.LDContext = {
  kind: "service",
  key: "hive",
  name: "Hive",
};
