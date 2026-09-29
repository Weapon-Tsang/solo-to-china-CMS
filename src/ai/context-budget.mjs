import fs from "node:fs";

const DEFAULT_BUDGETS = JSON.parse(fs.readFileSync(new URL("../../config/context-budgets.json", import.meta.url), "utf8"));

export function contextBudgetFor(stage, budgets = DEFAULT_BUDGETS) {
  const value = Number(budgets?.stages?.[stage]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Returns an overrun record, or null when the request fits its stage budget. */
export function checkContextBudget({ stage, estimatedTokens }, budgets = DEFAULT_BUDGETS) {
  const budget = contextBudgetFor(stage, budgets);
  const estimate = Number(estimatedTokens || 0);
  if (!budget || estimate <= budget) return null;
  return { stage, budget, estimatedTokens: estimate, ratio: Number((estimate / budget).toFixed(2)),
    budgetVersion: budgets?.version || null };
}

export { DEFAULT_BUDGETS as CONTEXT_BUDGETS };
