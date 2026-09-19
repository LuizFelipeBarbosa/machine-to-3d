import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Catalog } from './catalog';

const CatalogContext = createContext<Catalog | null>(null);

export function CatalogProvider({ catalog, children }: { catalog: Catalog; children: ReactNode }) {
  return <CatalogContext.Provider value={catalog}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): Catalog {
  const catalog = useContext(CatalogContext);
  if (!catalog) {
    throw new Error('useCatalog must be used within a CatalogProvider.');
  }
  return catalog;
}
