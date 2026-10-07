export type IconName =
  | "salon"
  | "ordenes"
  | "nueva"
  | "catalogo"
  | "caja"
  | "admin"
  | "ventas"
  | "bitacora"
  | "reportes"
  | "cortesias"
  | "seguridad"
  | "arrow"
  | "search";
const paths: Record<IconName, string> = {
  ventas: "M5 3h14v18H5z M8 7h8m-8 4h8m-8 4h5",
  bitacora: "M4 4h16v16H4z M8 8h8m-8 4h8m-8 4h5",
  reportes: "M4 3v18h17M8 17v-5m5 5V7m5 10V4",
  cortesias:
    "M3 8h18v4H3z M5 12v9h14v-9M12 8v13M12 8C2 8 5 0 9 3l3 5c10 0 7-8 3-5z",
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
