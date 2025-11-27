export interface CalculationRow {
  id: string;
  label: string; // e.g., "12% Rule"
  reductionPercent: number; // e.g., 6.25
  inputMrp: number;
  newMrp: number;
  intermediateTradePrice: number; // The (100/105) step
  finalTradePrice: number; // The -20% step
  gstAmount: number; // The 5% step
}

export interface CalculationResult {
  row12: CalculationRow;
  row18: CalculationRow;
}
