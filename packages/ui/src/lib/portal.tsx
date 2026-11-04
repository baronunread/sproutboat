import { createContext, useContext } from "react";

/**
 * Where floating layers mount. Defaults to document.body. Wrap a subtree in
 * `PortalContainer` to keep its menus, selects, popovers and dialogs inside an
 * element, e.g. a `data-theme` scope that must theme them (the playground shows
 * light and dark side by side this way). The container needs `position: relative`.
 */
const PortalContext = createContext<HTMLElement | null>(null);
export const PortalContainer = PortalContext.Provider;
export const usePortalContainer = (): HTMLElement | undefined => useContext(PortalContext) ?? undefined;
