# DSH Workload Report — relatório de carga de trabalho e uso de tokens

> **Tempo de trabalho e uso de tokens na mesma visão** — por **data** e por **espaço de trabalho**: mapa de calor do calendário, análise por hora, participação por espaço de trabalho, uso de modelos e um **relatório HTML autocontido** pronto para enviar a um cliente, em **8 idiomas**.

[![npm](https://img.shields.io/npm/v/dsh-workload-report?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-workload-report)
[![license](https://img.shields.io/github/license/tableau-China/dsh-workload-report?style=flat-square)](../../LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/tableau-China/dsh-workload-report/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tableau-China/dsh-workload-report/actions)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js)](https://nodejs.org)

[English](../../README.md) · [中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [Español](./README.es.md) · [Русский](./README.ru.md) · **[Português](./README.pt.md)**

![Relatório de carga de trabalho DSH](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png)

*Painel por data: cartões de KPI, mapa de calor do calendário, análise por hora e participação por espaço de trabalho.*

## O que é

O **DeepSeek Harness (DSH)** mostra as estatísticas da **sessão atual**. Este **plugin DSH** adiciona a visão entre sessões, projetos e períodos: em quais datas e **espaços de trabalho** o seu **tempo de trabalho** foi investido, em quais horas você produziu mais, quais modelos consumiram os **tokens** e quanto isso custou.

**Não só o consumo, mas o trabalho por trás dele.** O tempo ativo, os dias ativos e os turnos mostram o que você fez; o **uso de tokens** e o custo estimado mostram o que foi consumido. Todas as telas e o **relatório** exportado usam as mesmas definições, então os números batem entre si.

A interface é **multilíngue**: painel de uso, relatório HTML, perfil de usuário com IA, diálogos de sincronização e mensagens de erro do servidor seguem o idioma do DSH (**8 idiomas**) e trocam ao vivo, sem configuração própria.

## Recursos

- **Carga de trabalho e tokens na mesma visão**: tempo ativo = tempo de modelo + ferramentas, **sem a espera pelo usuário** (mostrada em separado); tokens totais e custo estimado no mesmo painel.
- **Por data, espaço de trabalho, modelo e sessão**: mapa de calor de calendário (seg–dom × ano–semana), análise por hora com densidade de mensagens humanas, participação por espaço de trabalho e uso por modelo.
- **Detalhes por modelo**: velocidade (tok/s), TTFT, taxa de acerto de cache, provedor e custo estimado; o custo só é estimado para modelos com preço público oficial.
- **Relatório HTML autocontido, pronto para enviar a um cliente**: um único arquivo com CSS e SVG embutidos, **sem scripts e sem recursos externos**; tema claro/escuro, título e nota personalizados, e opção de anonimizar nomes de espaços de trabalho e títulos de sessão.
- **Perfil de usuário com IA (opcional, manual)**: o modelo só é chamado depois de clicar em **Gerar perfil**, com **estatísticas agregadas** (sem conversas, títulos ou caminhos); em caso de falha, cai nas regras locais determinísticas.
- **Sincronização entre dispositivos (desligada por padrão)**: combine o uso de várias máquinas via Tencent COS, GitHub, Gitea ou pasta compartilhada.
- **8 idiomas de interface**: português (Brasil), inglês, chinês, japonês, espanhol, francês, alemão e russo — o plugin segue o idioma do DSH.
- **Apenas interfaces oficiais**: o plugin usa somente as APIs oficiais do DSH e, por padrão, **não faz requisições externas** — os dados ficam na sua máquina.

## Instalação

```bash
# npm (pacote publicado)
dsh plugin add dsh-workload-report

# ou direto do GitHub (branch main)
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

Reinicie o perfil Web do DSH depois de instalar. A entrada aparece no **final da barra lateral**: **Workload report** (o rótulo segue o idioma da interface). O bundle do cliente (`lib/client.js`) já está no repositório, então instalar via npm ou GitHub **não exige build local**.

Para desinstalar: `dsh plugin --profile web remove dsh-workload-report`.

## Links

- [README em inglês](../../README.md)
- [README em chinês](./README.zh-CN.md)
- [Definições das métricas (docs/metrics.md)](../metrics.md)
- [Arquitetura de i18n e manutenção (docs/i18n.md)](../i18n.md)
- [Sincronização entre dispositivos (docs/sync.md)](../sync.md)
- [Histórico de versões (CHANGELOG)](../../CHANGELOG.md)
- [Publicação no blog em vizwise.cn](https://vizwise.cn/posts/dsh-workload-report)
- [Licença MIT](../../LICENSE)

Estado: **v2.5.0** · 8 idiomas de interface · **1738 testes offline** (`node test/verify.mjs`).

**Palavras-chave**: DeepSeek Harness, plugin DSH, uso de tokens, carga de trabalho, relatório HTML, painel de uso, tempo de trabalho, espaço de trabalho, perfil de IA, sincronização entre dispositivos.
