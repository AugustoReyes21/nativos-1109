export type IconName =
  | "salon"
  | "ordenes"
  | "nueva"
  | "catalogo"
  | "caja"
  | "admin"
  | "seguridad"
  | "arrow"
  | "search";
const paths: Record<IconName, string> = {
  salon: "M5 7h14v10H5z M8 3v2m8-2v2M8 19v2m8-2v2M1 10h2m18 0h2M1 14h2m18 0h2",
  ordenes: "M6 3h12v18H6z M9 8h6m-6 4h6m-6 4h4",
  nueva: "M12 5v14M5 12h14",
  catalogo: "M4 4h6v6H4z m10 0h6v6h-6z M4 14h6v6H4z m10 0h6v6h-6z",
  caja: "M3 7h18v13H3z M7 7V4h10v3M3 12h18m-11 4h4",
  admin:
    "M4 20v-3c0-3 3-4 5-4s5 1 5 4v3M16 4c4 0 4 6 0 6m1 3c3 0 4 2 4 4v3M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  seguridad: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M8 12l3 3 5-6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
};
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
