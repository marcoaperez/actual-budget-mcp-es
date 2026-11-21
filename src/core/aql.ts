/** Rango de fechas inclusivo. El compilador AQL de Actual solo compila el primer operador de
 *  un objeto `{ $gte, $lte }` y descarta el resto en silencio, así que cada cota va en su filtro. */
export function dateRange(start: string, end: string) {
  return { $and: [{ date: { $gte: start } }, { date: { $lte: end } }] } as {
    $and: [{ date: { $gte: string } }, { date: { $lte: string } }];
  };
}
