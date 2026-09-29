/** Today's date in India as YYYY-MM-DD. */
export const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
export const fmtDate = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** Start of the Indian financial year containing `d`. */
export const fyStart = (d: string) => { const [y, m] = d.split("-").map(Number); return `${m >= 4 ? y : y - 1}-04-01`; };
