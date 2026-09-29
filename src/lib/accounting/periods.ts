/** Financial year containing `d`, given a start month (4 = April). */
export function financialYearFor(d: Date, startMonth = 4) {
  const y = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
  const start = `${y}-${String(startMonth).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(y + 1, startMonth - 1, 0));
  const end = endDate.toISOString().slice(0, 10);
  const name = startMonth === 4 ? `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}` : `FY ${start} to ${end}`;
  return { name, start, end };
}

