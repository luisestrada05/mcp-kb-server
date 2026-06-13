---
id: feature:calc-diferidos
type: feature
name: Calculadora de diferidos
terms: [diferidos, calculadora, ui]
status: in_progress
owner: frontend
depends_on: [rule:diferidos, rule:promociones]
---

Componente UI que permite simular el costo y plazo de un pago diferido a MSI
para un cliente y producto dado. Debe respetar las reglas de diferidos y
promociones vigentes al momento de la simulación.

La simulación es solo informativa — la oferta final se calcula en el backend.
