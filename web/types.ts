export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
  mfa_enabled: boolean;
  active?: boolean;
};
export type Product = {
  id: string;
  name: string;
  category_id: string;
  price_cents: number;
  stock: number;
  version: number;
  active: boolean;
  description: string;
};
export type Named = { id: string; name: string };
export type DiningTable = Named & {
  floor: 1 | 2;
  capacity: number;
  shape: "square" | "round" | "rectangle";
  display_order: number;
  version: number;
};
export type Catalog = {
  products: Product[];
  categories: Named[];
  tables: DiningTable[];
};
export type Item = {
  product_id: string;
  name: string;
  quantity: number;
  price_cents: number;
  notes: string;
  courtesy_quantity: number;
};
export type Order = {
  id: string;
  number: string;
  table_name: string;
  table_id: string;
  table_floor: 1 | 2;
  status: string;
  total_cents: number;
  courtesy_cents: number;
  version: number;
  notes: string;
  items: Item[];
  paid: boolean;
  created_at: string;
  waiter: string;
};
export type Shift = {
  id: string;
  closed_at: string | null;
  current_expected_cents: string;
  difference_cents: string | null;
};
export type Action = (operation: () => Promise<void>) => Promise<void>;
export type Mutate = <T>(
  path: string,
  data: unknown,
  method?: string,
) => Promise<T>;
export const human = (v: string) => v.replaceAll("_", " ");
