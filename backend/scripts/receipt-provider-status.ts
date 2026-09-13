const HELP = `Usage: npm run ops:receipt-provider:status -- [--require-disabled|--require-operational]

Reads the receipt-provider environment and emits status fields only. It does
not contact a provider, reserve budget, or read receipt data.`;

type RequiredState = "disabled" | "operational" | null;

function requiredState(argv: string[]): RequiredState | "help" | "invalid" {
  if (argv.length === 0) return null;
  if (argv.length !== 1) return "invalid";
  if (argv[0] === "--help" || argv[0] === "-h") return "help";
  if (argv[0] === "--require-disabled") return "disabled";
  if (argv[0] === "--require-operational") return "operational";
  return "invalid";
}

function configuredBudgetState(value: string | undefined, parsedValue: number | null): string {
  if (value === undefined || value.trim() === "") return "not-set";
  return parsedValue !== null && parsedValue > 0 ? "bounded" : "zero-or-invalid";
}

export async function providerStatus(
  environment: NodeJS.ProcessEnv,
  argv: string[],
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const requirement = requiredState(argv);
  if (requirement === "help") return { exitCode: 0, output: { help: HELP } };
  if (requirement === "invalid") {
    return {
      exitCode: 64,
      output: { check: "receipt-provider", status: "failed", errorCode: "INVALID_ARGUMENT" },
    };
  }

  const { getReceiptProviderConfiguration } = await import("../src/config/receiptProvider");
  const configuration = getReceiptProviderConfiguration(environment);
  const dispatchRequested = configuration.dispatchEnabled && !configuration.killSwitchActive;
  const state = configuration.operational ? "operational" : dispatchRequested ? "blocked" : "disabled";
  const resourceBudgetState = configuration.resourceMonthlyUnitLimit > 0 ? "bounded" : "zero-or-invalid";
  const businessBudgetState = configuredBudgetState(
    environment.RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT,
    configuration.businessMonthlyUnitLimit,
  );
  const requirementMet = requirement === null || requirement === state;

  return {
    exitCode: state === "blocked" || !requirementMet ? 1 : 0,
    output: {
      check: "receipt-provider",
      status: requirementMet ? state : "failed",
      localOcrDependency: "none",
      dispatch: configuration.dispatchEnabled ? "enabled" : "disabled",
      killSwitch: configuration.killSwitchActive ? "active" : "inactive",
      dataTerms: configuration.dataTermsApproved ? "approved" : "not-approved",
      routingCalibration: configuration.routingCalibrated ? "ready" : "not-ready",
      resourceBudget: resourceBudgetState,
      businessBudget: businessBudgetState,
      providerNetworkCalls: 0,
      ...(requirementMet ? {} : { errorCode: "REQUIRED_PROVIDER_STATE_NOT_MET" }),
    },
  };
}

async function main(): Promise<void> {
  const explicitEnvironment = { ...process.env };
  const result = await providerStatus(explicitEnvironment, process.argv.slice(2));
  if ("help" in result.output) console.log(result.output.help);
  else console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  void main().catch(() => {
    console.error(JSON.stringify({
      check: "receipt-provider",
      status: "failed",
      errorCode: "PROVIDER_STATUS_FAILED",
    }));
    process.exitCode = 1;
  });
}
