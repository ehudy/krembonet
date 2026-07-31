/**
 * Minimal client-side router.
 *
 * This exists instead of react-router because the app has four static routes
 * and one path parameter, while every published react-router version is
 * currently flagged by `npm audit` for issues in SSR, RSC, and data-router
 * features this app does not use. On a box where IT runs audits, carrying that
 * churn for `<Link>` and a path match was the worse trade.
 *
 * Scope is deliberately small: pushState navigation, back/forward, one param
 * segment. Anything beyond that is a signal to reconsider a real router.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface RouterValue {
  path: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentPath(): string {
  return window.location.pathname || '/';
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    // Covers the browser back and forward buttons, which is the part that is
    // easy to get wrong and annoying to discover later.
    const onPopState = (): void => setPath(currentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (to === currentPath()) return;

    if (options?.replace === true) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);

    setPath(to);
    window.scrollTo(0, 0);
  }, []);

  const value = useMemo<RouterValue>(() => ({ path, navigate }), [path, navigate]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (value === null) throw new Error('useRouter must be used inside RouterProvider');
  return value;
}

export interface LinkProps {
  to: string;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}

export function Link({ to, className, children, onClick }: LinkProps) {
  const { navigate } = useRouter();

  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        // Leave modified clicks alone so "open in new tab" still works, and
        // never hijack a right-click or middle-click.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Matches a pattern like `/printers/:slug` against the current path.
 * Returns the extracted params, or null when it does not match.
 */
export function matchPath(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected === undefined || actual === undefined) return null;

    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }

  return params;
}
