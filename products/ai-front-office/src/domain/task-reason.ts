/**
 * Why a callback task exists, in the owner's words. Tasks store an internal reason
 * ("Urgent life_safety call", "Resolve: call_ended_without_final_provider_payload"); owners see this.
 */
export function ownerTaskReason(reason: string): string {
  const text = reason.trim();
  if (/^urgent life_safety call$/i.test(text)) return "Emergency: call back now";
  if (/^urgent (?:urgent )?call$/i.test(text)) return "Urgent: call back soon";
  if (/^caller requested a human$/i.test(text)) return "Asked to talk to you";
  if (/^confirm requested appointment$/i.test(text)) return "Confirm their appointment";
  if (/^confirm requested service$/i.test(text)) return "Call back about the job";
  if (/^provider call ended without a final payload$/i.test(text)) return "Call dropped: call them back";
  if (/^resolve:/i.test(text)) return "Check the details and call back";
  return text;
}
