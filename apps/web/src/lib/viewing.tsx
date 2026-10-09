import { createContext, type ReactNode, useContext } from "react";

/**
 * Whose account the pages are showing. Normally the reader's own. When the operator reads through
 * a customer's, the same pages are shown under another address and nothing on them may change.
 */
export interface Viewing {
  /** What every link inside the account starts with: "" for one's own. */
  base: string;
  /** True while the operator is reading a customer's account. Hides everything that writes. */
  readOnly: boolean;
}

const OWN: Viewing = { base: "", readOnly: false };
const ViewingContext = createContext<Viewing>(OWN);

export function ViewingProvider({ value, children }: { value: Viewing; children: ReactNode }) {
  return <ViewingContext.Provider value={value}>{children}</ViewingContext.Provider>;
}

export const useViewing = () => useContext(ViewingContext);

/** Where the operator reads an organization's account. */
export const readThroughBase = (organizationId: string) => `/operator/o/${organizationId}`;
