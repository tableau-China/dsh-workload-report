# Informe de carga de trabajo para DSH

> **El tiempo de trabajo y el uso de tokens en la misma vista** — por **fecha** y **espacio de trabajo**: mapa de calor de calendario, análisis por hora, reparto de tokens por modelo y un **informe HTML autocontenido, listo para enviar a un cliente**.
> Plugin de DeepSeek Harness (DSH). Versión actual: **2.5.0**, disponible en 8 idiomas.

[English](../../README.md) · [中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · **[Español](./README.es.md)** · [Русский](./README.ru.md) · [Português](./README.pt.md)

![Informe de carga de trabajo DSH](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png)

## Qué es

DSH (DeepSeek Harness) muestra las estadísticas de la **sesión actual**. Este plugin de DSH añade la vista que cruza sesiones, proyectos y tiempo: en qué fechas y espacios de trabajo se ha invertido el tiempo, en qué horas has sido más productivo, qué modelos han consumido los **tokens** y cuánto ha costado.

**No solo el coste, también el trabajo detrás.** El tiempo activo, los días activos y los turnos muestran lo que se ha hecho; el uso de tokens y el coste estimado, lo que ha consumido. El panel y el informe exportado usan las mismas definiciones, así que las cifras coinciden entre sí.

Es un panel de uso para el día a día y también para compartir: el mismo informe HTML sirve para un cliente, para el equipo o para un balance mensual. La interfaz, el informe, el perfil de IA y los diálogos de sincronización son **multilingües** y siguen el idioma de DSH.

Calidad verificable: el proyecto mantiene **1738 pruebas offline** y no publica cifras estimadas sin base; si un modelo no tiene precio público oficial, la tabla muestra «—» en lugar de un coste inventado.

## Funciones

- **Carga de trabajo y tokens en la misma vista**: tiempo activo (tiempo de modelo + tiempo de herramientas, sin las esperas de usuario) junto con los tokens totales y por componente (entrada, salida, caché).
- **Por fecha, espacio de trabajo, modelo y sesión**: rangos de 7, 30 y 90 días o todo el historial; ámbito de todas las sesiones, solo principales o solo subagentes.
- **Mapa de calor de calendario y análisis por hora**: actividad por día (calendario de lunes a domingo por semana del año, color = tiempo activo) y franjas horarias con densidad de mensajes humanos.
- **Detalle por modelo**: velocidad tok/s, TTFT, tokens, solicitudes, aciertos de caché y coste estimado; el coste solo se estima para modelos con precio público oficial.
- **Informe HTML autocontenido**: un único archivo con CSS y SVG en línea, sin scripts ni recursos externos, **listo para enviar a un cliente**; incluye la opción de anonimizar los espacios de trabajo y los títulos de sesión.
- **Perfil de usuario con IA**: solo se genera al pulsar el botón y solo con estadísticas agregadas (sin conversaciones, títulos ni rutas); si no hay modelo disponible, usa reglas locales.
- **Sincronización multidispositivo** (desactivada por defecto): COS de Tencent Cloud, GitHub, Gitea o una carpeta compartida; filtro por dispositivo y envío / recepción manuales.
- **Multilingüe y local**: 8 idiomas de interfaz que siguen el idioma de DSH; solo se usan las interfaces oficiales del harness y no hay peticiones externas por defecto.

## Instalación

```bash
# npm (paquete publicado)
dsh plugin add dsh-workload-report

# o directamente desde GitHub
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

Reinicia el perfil Web después de instalar: la entrada **Informe de carga** aparece al final de la barra lateral y su etiqueta sigue el idioma de DSH. El bundle del cliente (`lib/client.js`) ya está compilado, así que instalar desde GitHub o npm no requiere compilar.

Desinstalar: `dsh plugin --profile web remove dsh-workload-report`.

## Idiomas

El plugin no tiene un ajuste de idioma propio: el panel, el informe HTML, el perfil de IA y los diálogos de sincronización siguen el idioma de DSH (Ajustes → General → Idioma) y cambian en vivo.

Idiomas disponibles: English, 中文, 日本語, Español, Français, Deutsch, Русский y Português (Brasil). El informe exportado también acepta `?lang=es` en la URL.

## Privacidad

Por defecto no hay peticiones externas ni telemetría: las estadísticas se calculan en tu equipo a partir de las interfaces oficiales del harness, y el plugin solo escribe su propio índice local y la caché del perfil de IA.

Las únicas llamadas externas posibles son el chip de saldo (opcional, desactivado por defecto) y el perfil con IA, que solo llama a un modelo después de pulsar **Generar perfil** y únicamente envía estadísticas agregadas.

## Enlaces

- [README en inglés](../../README.md)
- [README en chino](./README.zh-CN.md)
- [Definiciones de métricas](../metrics.md)
- [Arquitectura i18n y cómo añadir un idioma](../i18n.md)
- [Sincronización multidispositivo](../sync.md)
- [Historial de cambios](../../CHANGELOG.md)
- [Artículo en el blog (vizwise.cn)](https://vizwise.cn/posts/dsh-workload-report)
- [Licencia MIT](../../LICENSE)

**Palabras clave**: informe de carga, DeepSeek Harness, plugin DSH, uso de tokens, tiempo de trabajo, panel de uso, espacio de trabajo, informe HTML, multilingüe, sincronización multidispositivo
