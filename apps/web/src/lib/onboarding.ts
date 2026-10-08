/**
 * Questions a customer might ask an assistant about a business like this one, to start a new
 * location off. They are only suggestions: the owner picks, and can write their own later.
 */
export function suggestPrompts(category: string, city: string): string[] {
  const what = category.trim().toLowerCase();
  const where = city.trim();
  if (!what || !where) return [];
  return [
    `Who is the best ${what} in ${where}?`,
    `Can you recommend a ${what} in ${where}?`,
    `Which ${what} in ${where} has the best reviews?`,
    `I need a ${what} in ${where}. Who should I call?`,
    `What is the most trusted ${what} in ${where}?`,
    `Who is an affordable ${what} in ${where}?`,
  ];
}

/** How many suggestions start ticked. */
export const PRESELECTED = 3;
