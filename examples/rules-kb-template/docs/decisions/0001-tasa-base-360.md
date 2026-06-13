---
id: decision:adr-0001
type: decision
name: ADR-0001 — Tasa de interés calculada sobre base 360
terms: [base-360, adr, calculo-interes]
status: accepted
owner: tesoreria
date: 2025-09-15
supersedes: rule:tasa-vieja-base-365
defines: [term:tasa-ordinaria]
cites: [rule:tasa-interes]
---

## Contexto

Históricamente el cálculo de la tasa ordinaria usaba base 365 para días
de cómputo, pero la regulación CNBV exige base 360 para productos al
consumo. La inconsistencia generó observaciones en auditoría.

## Decisión

A partir de 2025-10-01 toda la cartera nueva se origina con cálculo de
interés sobre base 360. La cartera existente migra contractualmente al
renovar.

## Consecuencias

- Pequeña reducción del interés diario percibido por la SOFOM
- Cumplimiento regulatorio alineado
- Migración de cartera vigente debe completarse antes de 2026-12-31

## Alternativas descartadas

Mantener base 365 y disputar la interpretación regulatoria: descartada
por riesgo legal.
