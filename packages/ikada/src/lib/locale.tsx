import { createContext, useContext } from "react";
import { DEFAULT_LOCALE } from "./format";

const LocaleContext = createContext<string>(DEFAULT_LOCALE);

/** Sets the number-formatting locale for a subtree. Default `en`. A component's own `locale` prop wins. */
export const LocaleProvider = LocaleContext.Provider;

/** The locale to format with: the explicit one, else the provider's, else `en`. */
export function useLocale(override?: string): string {
  const inherited = useContext(LocaleContext);
  return override ?? inherited;
}
