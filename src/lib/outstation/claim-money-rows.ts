/**
 * The money on a claim, only what it holds: fuel for a car, tickets otherwise, never a row of zeros.
 * The travel cost includes the tickets, so a ticket is shown once, on its own row.
 */
export function claimMoneyRows(claim: {
  allowanceAmount: number;
  meetingAmount: number;
  otherAmount: number;
  ticketAmount: number;
  transportationType: string;
  travelCost: number;
}): Array<{ amount: number; label: string }> {
  const travelBeyondTickets = Math.max(0, claim.travelCost - claim.ticketAmount);
  return [
    { amount: travelBeyondTickets, label: claim.transportationType === "car" ? "Fuel" : "Travel" },
    { amount: claim.ticketAmount, label: "Tickets" },
    { amount: claim.meetingAmount, label: "Meeting" },
    { amount: claim.otherAmount, label: "Other" },
    { amount: claim.allowanceAmount, label: "Allowance" },
  ].filter((row) => row.amount > 0);
}
