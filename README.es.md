[English](README.md) | **Español**

# Actual Budget MCP Server

> Esta es la versión en español del README. For the English version, see [README.md](README.md).

Servidor MCP (Model Context Protocol) que conecta Claude Desktop / Claude.ai con una instancia self-hosted de [Actual Budget](https://actualbudget.org/). Permite consultar cuentas, transacciones, presupuestos y más directamente desde Claude usando lenguaje natural.

## Instalación en Claude Desktop (recomendado)

**Requisitos:** un Mac con Apple Silicon (M1 o posterior), Claude Desktop y un servidor de
Actual Budget self-hosted al que puedas acceder. En Macs Intel, Windows o Linux, usa la
[instalación manual](#instalación-manual) en su lugar.

1. **Descarga** la última versión de `actual-budget-mcp-es.mcpb` desde la
   [página de Releases](https://github.com/marcoaperez/actual-budget-mcp-es/releases/latest).
2. **Encuentra tu Sync ID** — abre Actual Budget en el navegador, ve a **Settings** →
   **Advanced Settings** → **IDs**, y copia el **Sync ID**.
3. **Instala** — en Claude Desktop, abre **Settings → Extensions**, arrastra el archivo
   `.mcpb` descargado a la página, revisa lo que declara y pulsa **Install**. Claude Desktop
   avisará de que la extensión no está firmada — es lo esperado en un bundle autodistribuido.
4. **Rellena el formulario** que muestra Claude Desktop:
   - **Actual server URL** — p. ej. `https://actual.example.org/`
   - **Server password** — la misma que usas para abrir Actual en el navegador (se guarda
     en el almacenamiento seguro de Claude Desktop, no en un archivo de configuración)
   - **Budget Sync ID** — el del paso 2
   - **Locale** y **Currency** — p. ej. `es-ES` y `EUR`; los valores por defecto son `en-US` y `USD`
   - **Enable write tools** — déjalo **desactivado** por ahora (ver más abajo)
   - **Message language** — `es` o `en`; por defecto `es`
5. **Comprueba que funciona** — empieza una conversación nueva y pregunta *"¿qué cuentas tengo?"*.
   Deberías obtener tu lista de cuentas con sus saldos.

### Activar el acceso de escritura

Con la casilla desactivada tienes las 14 tools de solo lectura. Actívala (Settings →
Extensions → esta extensión → configurar) para añadir las 23 tools de escritura: editar y
categorizar movimientos, splits reales, repetitivos, asignación de presupuesto, notas de
categoría, gestión de grupos de categorías/categorías, beneficiarios/transferencias, conciliación bancaria (enlazar/fusionar duplicados, marcar conciliado), importaciones sin duplicados, plantillas de presupuesto y reglas
de automatización. Claude Desktop pide tu aprobación antes de cada llamada salvo que le
concedas permiso permanente. Las tools de clasificación (categorías, grupos de categorías,
reglas, `set_transaction_transfer`) sincronizan con el servidor tras cada escritura — las 8
tools de escritura de versiones anteriores no lo hacen por sí mismas, dependen del siguiente
sync programado. Las tools de borrado (`delete_category`, `delete_category_group`,
`delete_rule`) exigen
`confirm_delete: true` y ofrecen archivar (`hidden: true`) como alternativa no destructiva
por defecto.

### Actualizar

Descarga el `.mcpb` más reciente y vuelve a arrastrarlo — tu configuración se conserva. Tras instalarlo, **cierra Claude Desktop del todo (Cmd+Q) y vuelve a abrirlo**; cerrar la ventana no basta para que arranque el servidor nuevo.

### Si todas las tools fallan tras actualizar Claude Desktop

Desde la versión 2.3.0 el módulo SQLite que viaja en el bundle está hecho sobre Node-API, así
que sigue cargando cuando Claude Desktop actualiza su Electron interno. Los bundles anteriores
(2.2.x y previos) estaban atados a un runtime concreto y dejaban de funcionar tras una de esas
actualizaciones: si usas uno y fallan todas las herramientas, instala la 2.3.0 o posterior.

## Instalación manual

Para otros clientes MCP, Macs Intel, Windows y Linux. Requiere Node.js >= 22 y un servidor
de Actual Budget self-hosted accesible por red.

El proyecto está escrito en TypeScript, así que hay que compilarlo antes de usarlo:

```bash
git clone https://github.com/marcoaperez/actual-budget-mcp-es.git
cd actual-budget-mcp-es
npm install
cp .env.example .env
# Editar .env con tu contraseña de Actual Budget
npm run build          # compila TypeScript a dist/
```

Esto genera `dist/index.js`, el punto de entrada que ejecuta tu cliente MCP.

¿Necesitas tu Sync ID? Consulta el paso 2 de
[Instalación en Claude Desktop](#instalación-en-claude-desktop-recomendado), más arriba.

### Configuración del cliente

Añade esta configuración al archivo `claude_desktop_config.json` (o el equivalente de tu
cliente MCP):

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Apunta `command` a `node` y `args` al `dist/index.js` compilado (usa una ruta absoluta):

```json
{
  "mcpServers": {
    "actual-budget": {
      "command": "node",
      "args": ["/ruta/absoluta/actual-budget-mcp-es/dist/index.js"],
      "env": {
        "ACTUAL_SERVER_URL": "https://actual.example.org/",
        "ACTUAL_SERVER_PASSWORD": "tu-password",
        "ACTUAL_SYNC_ID": "00000000-0000-0000-0000-000000000000",
        "LOCALE": "es-ES",
        "CURRENCY": "EUR",
        "ENABLE_WRITE": "false"
      }
    }
  }
}
```

> Sustituye la ruta por la ruta absoluta real en tu equipo, y `tu-password` por la contraseña real.
> Recuerda ejecutar `npm run build` antes (y tras cada cambio) para regenerar `dist/`.

Durante el desarrollo puedes evitar la compilación usando `tsx` directamente:
`"command": "npx"`, `"args": ["tsx", "/ruta/absoluta/actual-budget-mcp-es/src/index.ts"]`.

Tras guardar, cierra Claude Desktop del todo (Cmd+Q) y vuelve a abrirlo (o reinicia tu cliente) para que detecte el nuevo servidor MCP.

### Variables de entorno

Las tres primeras son obligatorias; el resto tienen valores por defecto.

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `ACTUAL_SERVER_URL` | Sí | — | URL del servidor Actual self-hosted |
| `ACTUAL_SERVER_PASSWORD` | Sí | — | Contraseña del servidor Actual |
| `ACTUAL_SYNC_ID` | Sí | — | Sync ID del presupuesto (Settings → Advanced → Sync ID) |
| `ACTUAL_DATA_DIR` | No | `./data` | Carpeta donde se descarga la copia local del presupuesto |
| `LOCALE` | No | `en-US` | Locale para formatear importes y fechas (ej. `es-ES`) |
| `CURRENCY` | No | `USD` | Código ISO de moneda de 3 letras (ej. `EUR`) |
| `SYNC_TTL_SECONDS` | No | `60` | Segundos que se cachea el sync antes de volver a sincronizar |
| `ENABLE_WRITE` | No | `false` | Habilita las 23 tools de escritura (categorizar, splits, schedules, presupuesto, notas, grupos de categorías/categorías, beneficiarios/transferencias, reglas, conciliación, importaciones, plantillas de presupuesto) |
| `MESSAGES_LANG` | No | `es` | Idioma de los mensajes de error del servidor: `es` o `en` |

## Herramientas disponibles

El servidor expone 14 herramientas de solo lectura:

| Herramienta | Descripción |
|---|---|
| `get_accounts` | Cuentas con balance actual. Incluye off-budget (pensiones, fondos, hipoteca) por defecto |
| `get_net_worth` | Patrimonio neto completo: on-budget + off-budget con desglose por cuenta |
| `get_categories` | Grupos y categorías con sus IDs (los IDs son necesarios para las tools de escritura) |
| `get_payees` | Beneficiarios con sus IDs; un beneficiario con `transfer_account_id` es el que Actual usa para representar esa cuenta en una transferencia |
| `get_account_transfer_payee` | El beneficiario que representa una cuenta concreta en una transferencia — atajo sobre `get_payees` |
| `get_transactions` | Transacciones por rango de fechas con filtros opcionales (cuenta, categoría, texto, importe, sin categorizar). Excluye transferencias. Paginado (máx. 200) |
| `get_spending_summary` | Gasto agregado por categoría, beneficiario o mes. Excluye transferencias siempre, así que una transferencia categorizada entre lados del presupuesto (p. ej. la parte de capital de una cuota hipotecaria enviada con categoría a una cuenta de préstamo fuera de presupuesto) no cuenta aquí, aunque el presupuesto de Actual sí la cuenta (pendiente decidir si se cambia) |
| `get_budget_month` | Estado del presupuesto de un mes: to-budget, ingresos, totales y asignado/gastado/balance por categoría |
| `get_budget_averages` | Media, mediana y máximo de gasto por categoría en los últimos N meses completos — insumo para preparar el presupuesto |
| `get_schedules` | Repetitivos configurados en Actual (nombre, próxima fecha, importe) |
| `get_rules` | Reglas de automatización con sus IDs; las reglas se ejecutan al importar movimientos y son cómo los movimientos recurrentes se autoclasifican |
| `find_transfer_issues` | Revisa un rango de fechas en busca de transferencias sin enlazar, movimientos del banco duplicados por otros manuales y movimientos del banco que deberían ser transferencias a una cuenta manual; propone cada arreglo con su confianza (`alta`/`dudosa`) y no escribe nada. Desde la 2.5.0 las propuestas `create_transfer` bajan a `dudosa`, con un motivo legible, si el nombre del beneficiario, el beneficiario importado o las notas llevan palabras de nómina, factura o impuestos o si no hay movimiento compensatorio a ±60 días |
| `get_category_note` | Lee la nota de una categoría, sus líneas `#template`/`#goal` y si la categoría toma su plantilla de presupuesto de la nota o de la interfaz de plantillas de Actual (las categorías con plantillas de interfaz ignoran las de la nota) |
| `reconcile_account` | Compara una cuenta (id o nombre) con el saldo que da el banco al cierre de una fecha: saldo en Actual, diferencia, saldo conciliado y, si no cuadra, los arreglos propuestos para esa cuenta y los movimientos cuyo importe explica por sí solo la diferencia. No escribe nada |

## Herramientas de escritura

Con `ENABLE_WRITE=true` el servidor expone además estas 23 herramientas de escritura:

| Herramienta | Descripción |
|---|---|
| `update_transaction` | Corregir un movimiento (importe, categoría, beneficiario, notas, fecha). `category_id: null` lo descategoriza; `payee_id` fija un beneficiario existente, `payee_name` lo resuelve/crea. También edita categoría, notas y beneficiario de las **partes de un split** (las partes rechazan importe, fecha y cleared; en un padre de split solo se rechazan importe y categoría). Se niega a cambiar el importe de una pata de transferencia si la otra pata es una parte de split, está conciliada o viene del banco (Actual la reescribiría), y se niega a cambiar el beneficiario de una transferencia (usa `remove_transaction_transfer`) o a poner un beneficiario de transferencia (usa `set_transaction_transfer`) |
| `categorize_transactions` | Categorizar en lote (máx. 50), con resultado por elemento. Funciona también con las **partes de un split**; el padre de un split se rechaza (su categoría vive en las partes) |
| `split_transaction` | Dividir un movimiento en partes reales, in situ (mismo id). Las partes pueden ser **transferencias** (`transfer_account_id`) y se puede dividir una transferencia existente; se niega si la otra pata viene del banco, está conciliada o es parte de un split |
| `create_transaction` | Apuntar un gasto/ingreso, con splits opcionales en la creación |
| `create_schedule` | Crear un repetitivo (schedule) |
| `set_budget` | Asignar presupuesto en lote a varias categorías de un mes |
| `transfer_budget` | Mover presupuesto asignado entre categorías |
| `update_category_note` | Notas de categoría y plantillas de objetivos (templates); avisa si la categoría usa plantillas de interfaz, que ignoran las de la nota |
| `import_transactions` | Importa movimientos con un `imported_id` estable (p. ej. `fcf-<nombre>-2026-11`) sin duplicados. **Simulación por defecto**: la vista previa clasifica cada fila como `add`, `update`, `unchanged`, `fuzzy` (se parece a un movimiento existente), `skipped_fuzzy` o `kept_deleted`. `allow_fuzzy` importa las dudosas; las filas que borraste antes no se reimportan nunca |
| `apply_budget_templates` | Ejecuta las plantillas de presupuesto (líneas `#template`/`#goal` en las notas de categoría) de un mes. Por defecto solo rellena las categorías sin presupuesto; `overwrite: true` las recalcula todas. **Experimental en Actual 26.11**: las categorías definidas con la interfaz de plantillas ignoran las de la nota. Los errores de plantilla se informan y no se escribe nada |

**Grupos de categorías y categorías**

| Herramienta | Descripción |
|---|---|
| `create_category_group` | Crear un nuevo grupo de categorías (los contenedores de nivel superior que agrupan categorías) |
| `update_category_group` | Renombrar un grupo de categorías o archivarlo (`hidden: true`) — la alternativa no destructiva a `delete_category_group` |
| `delete_category_group` | Borrar permanentemente un grupo de categorías y todas las categorías que contiene. Exige `confirm_delete: true`; si alguna tiene movimientos, `transfer_category_id` es obligatorio |
| `create_category` | Crear una categoría dentro de un grupo existente |
| `update_category` | Renombrar una categoría, moverla a otro grupo, o archivarla (`hidden: true`) — la alternativa no destructiva a `delete_category` |
| `delete_category` | Borrar permanentemente una categoría. Exige `confirm_delete: true`; si tiene movimientos, `transfer_category_id` es obligatorio |

**Beneficiarios y transferencias**

| Herramienta | Descripción |
|---|---|
| `set_transaction_transfer` | Convertir un movimiento normal (o una **parte de un split**) en una transferencia con otra cuenta, apuntándolo al beneficiario de transferencia de esa cuenta. Actual crea y enlaza el movimiento correspondiente en la otra cuenta. Si la cuenta destino se sincroniza con el banco, el resultado incluye un aviso (el banco importará su propia pata; para unir dos movimientos que ya existen usa `find_transfer_issues`). Acepta `category_id` para transferencias a cuentas fuera del presupuesto. Re-apuntar una transferencia existente mueve su otra pata, así que se niega si esa pata es una parte de split, y si está conciliada o viene del banco salvo `force: true` |
| `remove_transaction_transfer` | Convierte una transferencia (pata normal o parte de un split) de nuevo en un movimiento ordinario con el beneficiario que indiques, y categoría y notas opcionales. Actual borra la otra pata, o solo la desvincula si es a su vez parte de un split. Se niega si la otra pata está conciliada o viene del banco salvo `force: true` (el resultado avisa entonces de que el sync bancario puede traerla de vuelta) |
| `apply_reconciliation_fixes` | Aplica las operaciones de conciliación que aceptes (enlazar, fusionar, crear transferencia), hasta 50 por llamada; cada una se revalida antes y se informa como aplicada, omitida (con el motivo) o fallida. Nunca toca movimientos conciliados ni divididos y conserva el identificador de importación del banco. Puede borrar filas: `merge` elimina el duplicado descartado y `link` puede borrar una contrapartida huérfana al revertir. Guardas: merge exige que la fila que se conserva sea del banco y la descartada no, misma cuenta e importe |
| `mark_reconciled` | Cuando una cuenta cuadra con el banco a una fecha, marca sus movimientos sin conciliar hasta esa fecha como liquidados y conciliados (como el botón de conciliar de Actual). Si el saldo no cuadra, se niega y no escribe nada; nunca crea un apunte de ajuste |

**Reglas**

| Herramienta | Descripción |
|---|---|
| `create_rule` | Crear una regla de automatización: una condición (p. ej. `imported_payee` contiene "X" — usa `imported_payee` [beneficiario importado], no `payee` [beneficiario], para que dispare la primera vez que se importa ese pagador) más una acción (p. ej. fijar categoría = id). Solo se aplica en futuras importaciones, nunca retroactivamente. Una acción que fija el beneficiario a un pagador de transferencia no crea una transferencia real; usa después `set_transaction_transfer` |
| `update_rule` | Reemplazar una regla de automatización — la API de Actual toma el objeto completo, así que hay que reenviar todos los campos que se quieran conservar |
| `delete_rule` | Borrar una regla de automatización. Los movimientos pasados conservan lo que la regla ya les aplicó; solo cambian las futuras importaciones |

> **Escritura desactivada por defecto.** Las tools de escritura solo aparecen si defines `ENABLE_WRITE=true` en el bloque `env` de `claude_desktop_config.json` (y cierras Claude Desktop del todo con Cmd+Q y lo reabres).
>
> - Los **importes se dan en unidades** de la moneda configurada (euros, no céntimos); el servidor hace la conversión.
> - `split_transaction` actualiza la transacción **in situ** con sus subtransacciones — el **id no cambia**.
> - Las tools de clasificación (categorías, grupos de categorías, reglas y `set_transaction_transfer`) **sincronizan con el servidor tras cada escritura** — las 8 tools de escritura de versiones anteriores no lo hacen, dependen del siguiente sync programado.
> - Las tools de borrado (`delete_category`, `delete_category_group`, `delete_rule`) exigen **`confirm_delete: true`**; archivar (`hidden: true`, vía `update_category`/`update_category_group`) es la alternativa no destructiva por defecto y conserva el historial.

### Corregido en 2.5.0

Antes de la 2.5.0, los rangos de fechas ignoraban `end_date` en `get_transactions`, `get_spending_summary`, `get_budget_averages` y las tools de conciliación, así que podían incluir datos posteriores a `end_date` (también los resúmenes de gasto y las medias). Si sacaste cifras de esas tools antes de actualizar, vuelve a calcularlas.

## Ejemplos de uso con Claude

Una vez configurado, puedes preguntar cosas como:

- "¿Cuánto he gastado este mes en restaurantes?"
- "¿Cuál es mi patrimonio neto actual?"
- "Muéstrame las transacciones de la última semana"
- "¿Cómo van mis presupuestos de enero y febrero?"
- "¿Cuáles son mis mayores gastos del último trimestre?"

Claude usará automáticamente las herramientas MCP para consultar tus datos reales de Actual Budget.

## Seguridad

- **NUNCA** commitear el archivo `.env` al repositorio
- La contraseña de Actual Budget va solo en `.env` local o en la config de Claude Desktop
- El `.gitignore` ya excluye `.env`, `node_modules/` y datos locales
- No hay tools de borrado directo de transacciones, cuentas ni asignaciones de presupuesto. Un movimiento puede desaparecer por tres vías protegidas: `remove_transaction_transfer` borra (o desvincula) la otra pata de una transferencia, `split_transaction` sobre una transferencia existente borra su gemela y `apply_reconciliation_fixes` borra el duplicado descartado en `merge` (y puede borrar una contrapartida huérfana al revertir un `link`; rechaza filas conciliadas y divididas, y merge exige conservar la importada, descartar la no importada, misma cuenta e importe). Las dos primeras se niegan si la otra pata está conciliada o viene del banco (`split_transaction` siempre; `remove_transaction_transfer` salvo `force: true`). Las únicas tools de borrado son `delete_category`, `delete_category_group` y `delete_rule`; cada una exige `confirm_delete: true`, y archivar (`hidden: true`) es la alternativa no destructiva por defecto
- Las tools de escritura no se registran sin `ENABLE_WRITE`; guardas de split: en un padre `update_transaction` rechaza importe y categoría (notas, beneficiario, fecha y cleared sí), y `categorize_transactions` y `set_transaction_transfer` rechazan padres; las partes se editan en categoría, notas y beneficiario y rechazan importe, fecha y cleared. Cambiar el importe o la fecha de una parte exige deshacer antes el split en Actual

Tres cosas que conviene saber antes de activar la escritura:

- `data/` guarda una **copia sin cifrar** de todo tu presupuesto (se crea con permisos `0700`, solo para ti).
- Los nombres de pagador y las notas vienen del banco o de importaciones CSV: son **texto no confiable**, no instrucciones. Mantén la aprobación por llamada activada en tu cliente MCP.
- `split_transaction` actualiza la transacción **in situ** — el id no cambia.
- Cada cliente MCP que conectes arranca su propio proceso del servidor. Actual solo permite
  que un proceso abra el presupuesto a la vez, así que las instancias extra usan
  automáticamente su propia copia local (`<data dir>-instance-<pid>`). En una instalación
  manual puedes dar a cada cliente su propio `ACTUAL_DATA_DIR` si prefieres controlarlo (el
  bundle de Claude Desktop no expone esta opción).

El modelo de seguridad completo — frontera de confianza, credenciales, operaciones destructivas, validación de entrada y cómo reportar una vulnerabilidad — está en [SECURITY.md](SECURITY.md) (en inglés).

## Política de privacidad

Este software no recopila nada: sin telemetría, sin analítica, sin comprobación de
actualizaciones. Se ejecuta en tu máquina y habla solo con **tu propio** servidor de Actual
Budget y con el cliente MCP al que lo conectes — que verá los datos financieros por los que
preguntes, bajo su propia política de privacidad. La copia local de tu presupuesto está sin
cifrar y vive solo en tu máquina.

Texto completo: [PRIVACY.es.md](PRIVACY.es.md) · [in English](PRIVACY.md)

## Desarrollo

### Ejecutar manualmente

```bash
npm run dev     # ejecuta src/index.ts con tsx (sin compilar)
npm start       # ejecuta dist/index.js (requiere npm run build antes)
```

El servidor se comunica por stdio (stdin/stdout), así que al ejecutarlo manualmente no verás output interactivo — los logs van a stderr.

### Tests y smoke

```bash
npm test        # suite completa con Vitest (325 tests)
npm run smoke   # comprobación manual contra el servidor Actual real (requiere .env)
```

El smoke imprime el número de cuentas y el patrimonio neto para contrastarlos con la UI de Actual. No forma parte de CI.

### Sandbox de desarrollo (una copia de tu propio presupuesto)

Para probar el MCP con tus datos reales sin tocar tu servidor:

1. `cp dev/.env.example dev/.env` y rellena de dónde sale la copia (un alias SSH y la ruta de tus
   backups nocturnos del directorio de datos de Actual) y el nombre del presupuesto. `dev/.env`
   está en `.gitignore`.
2. `npm run dev:refresh` — reconstruye un Actual local en `127.0.0.1:5007` a partir del backup más
   reciente, sin credenciales de sincronización bancaria y con la contraseña `actual-dev`.
   `-- --cold` hace en su lugar una copia en frío (para tu servidor unos segundos; te pide escribir
   `detener`). La copia se prepara en `dev/data.new` y solo sustituye al sandbox anterior cuando se
   ha traído y validado: si falla la descarga o la validación, el sandbox anterior y su Sync ID
   quedan como estaban. Un fallo posterior al intercambio (arranque del servidor o bootstrap) no
   deja sandbox utilizable: vuelve a ejecutarlo. `--cold` siempre intenta reiniciar tu servidor,
   también si falla, y te avisa de que lo compruebes si no ha podido. Tras un refresco, reinicia
   Claude Code (o el servidor `actual-dev`) para que se reconecte al sandbox nuevo.

   Requisitos en tu máquina: `docker`, `ssh`, `tar`, `sqlite3` ≥ 3.33 (para `-json`) y `lsof`; para
   `--cold`, `sudo` sin contraseña en el servidor.
3. Abre Claude Code en este repo: el servidor MCP `actual-dev` (de `.mcp.json`) ejecuta el código
   de `src/` con escritura activada, y se niega a arrancar si no apunta al sandbox.
4. ¿Has roto algo? Vuelve a ejecutar `npm run dev:refresh`.

### Añadir una nueva herramienta

1. Crea un archivo en `src/tools/mi_nueva_herramienta.ts`
2. Exporta una `ToolDef` (`name`, `description`, `readOnly`, `inputSchema` con Zod, `handler`)
3. Importa y registra la tool en el array `allTools` de `src/tools/index.ts`

El `handler(input, ctx)` recibe el contexto `{ api, config }` ya inicializado; usa `moneyFields`/`toUnits` de `src/core/money.js` para devolver siempre importes en unidades (nunca céntimos).

### Publicar un bundle

> **El bundle es N-API e independiente del Electron de Claude Desktop.** `better-sqlite3` 13
> (que trae `@actual-app/api` 26.10) carga en cualquier Node o Electron, así que no hay un
> build por versión de Electron ni hace falta volver a publicar cuando Claude Desktop suba de
> Electron. `npm run bundle` incluye los binarios precompilados tal como los deja `npm ci` y
> verifica con `nm` que los `darwin-*` son N-API (`darwin-arm64` es obligatorio; si falta, el
> empaquetado se detiene). El bundle es solo para macOS (`manifest.json` declara `darwin`).

1. Actualiza la `version` en `package.json` **y** en `manifest.json` (un test obliga a que coincidan).
2. `npm test && npm run build && npm run bundle` — las últimas líneas informan de la versión
   de Electron de Claude Desktop detectada (solo informativa), el resultado de la
   verificación N-API y la ruta y el tamaño del bundle.
3. Verifica el bundle:
   ```bash
   npx mcpb validate manifest.json
   unzip -l build/actual-budget-mcp-es.mcpb | grep -E 'tests/|docs/|\.env' | grep -v 'node_modules/'  # sin salida
   unzip -l build/actual-budget-mcp-es.mcpb | grep -c 'prebuilds/darwin-arm64.node'  # al menos 1
   ```
   `npx mcpb info <archivo>` (CLI 2.1.2) solo imprime nombre, tamaño y estado de firma —
   no valida el manifiesto, así que no sustituye a `validate`. La exclusión de
   `node_modules/` en el grep está ahí porque los archivos de dependencias empaquetadas
   no son código propio del proyecto y contienen legítimamente rutas como `tests/` — no la
   quites pensando que es un error.
4. Instala `build/actual-budget-mcp-es.mcpb` en local y comprueba que funciona.
5. `gh release create vX.Y.Z build/actual-budget-mcp-es.mcpb`, indicando en la descripción
   de la release que el bundle está dirigido a macOS en Apple Silicon.

## Notas técnicas

- Los importes de Actual están en céntimos; las tools los devuelven SIEMPRE convertidos a unidades de la moneda configurada (÷ 100 en el servidor, campos amount y amount_formatted).
- Las transferencias entre cuentas se identifican por `transfer_id` y se excluyen de los resúmenes para no doblar importes.
- La primera conexión a Actual Budget puede tardar unos segundos mientras descarga el presupuesto.

## Licencia

MIT — ver [LICENSE](LICENSE).
