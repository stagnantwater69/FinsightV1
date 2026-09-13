import { getReceiptProviderConfiguration } from "../src/config/receiptProvider";

type Scenario = {
  name: string;
  environment: NodeJS.ProcessEnv;
  expectedOperational: boolean;
};

const operationalBase: NodeJS.ProcessEnv = {
  RECEIPT_PROVIDER_DISPATCH_ENABLED: "true",
  RECEIPT_PROVIDER_KILL_SWITCH: "false",
  RECEIPT_PROVIDER_DATA_TERMS_APPROVED: "true",
  RECEIPT_PROVIDER: "gemini",
  RECEIPT_PROVIDER_VERSION: "gemini-3.5-flash-lite",
  RECEIPT_PROVIDER_REGION: "us",
  RECEIPT_PROVIDER_RETENTION_HOURS: "0",
  RECEIPT_PROVIDER_ROUTING_CALIBRATED: "true",
  RECEIPT_PROVIDER_CALIBRATION_VERSION: "smoke-v1",
  RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT: "1",
  GOOGLE_GEMINI_API_KEY: "non-secret-smoke-placeholder",
};

const scenarios: Scenario[] = [
  { name: "safe defaults", environment: {}, expectedOperational: false },
  {
    name: "credentials alone",
    environment: { GOOGLE_GEMINI_API_KEY: "non-secret-smoke-placeholder" },
    expectedOperational: false,
  },
  {
    name: "zero resource budget",
    environment: { ...operationalBase, RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT: "0" },
    expectedOperational: false,
  },
  {
    name: "over-cap resource budget",
    environment: { ...operationalBase, RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT: "101" },
    expectedOperational: false,
  },
  {
    name: "zero business budget",
    environment: { ...operationalBase, RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT: "0" },
    expectedOperational: false,
  },
  { name: "complete bounded configuration", environment: operationalBase, expectedOperational: true },
  {
    name: "kill switch",
    environment: { ...operationalBase, RECEIPT_PROVIDER_KILL_SWITCH: "true" },
    expectedOperational: false,
  },
];

export function runProviderGateSmoke(): void {
  let passed = 0;
  for (const scenario of scenarios) {
    const actual = getReceiptProviderConfiguration(scenario.environment).operational;
    if (actual !== scenario.expectedOperational) {
      throw new Error(`Scenario failed: ${scenario.name}`);
    }
    passed++;
  }
  console.log(JSON.stringify({
    check: "receipt-provider-gate-smoke",
    status: "ok",
    scenarioCount: scenarios.length,
    passedScenarioCount: passed,
    providerNetworkCalls: 0,
  }));
}

if (require.main === module) {
  try {
    runProviderGateSmoke();
  } catch {
    console.error(JSON.stringify({
      check: "receipt-provider-gate-smoke",
      status: "failed",
      errorCode: "PROVIDER_GATE_SCENARIO_FAILED",
      providerNetworkCalls: 0,
    }));
    process.exitCode = 1;
  }
}
