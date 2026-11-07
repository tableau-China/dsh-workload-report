# Rapport de charge et tokens pour DeepSeek Harness (DSH)

> **Voyez votre effort et votre consommation de tokens sur la même vue** — par **date** et par **espace de travail** : heatmap calendaire, analyse horaire, part des espaces de travail, utilisation des modèles et **rapport HTML autonome en un clic**, directement envoyable à un client.

[English](../../README.md) · [中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Deutsch](./README.de.md) · **[Français](./README.fr.md)** · [Español](./README.es.md) · [Русский](./README.ru.md) · [Português](./README.pt.md)

![Rapport de charge DSH](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png)

## Ce que c'est

DeepSeek Harness (DSH) affiche les statistiques de la **session en cours**. Ce plugin ajoute la vue transversale — toutes dates, tous espaces de travail et tous projets confondus : où passe votre temps de travail, quelles heures sont les plus productives, quels modèles consomment les tokens et combien cela coûte, avec un rapport statique pour vos clients, votre équipe ou votre bilan mensuel.

**Pas seulement le coût, mais le travail derrière.** Le temps actif, les jours actifs et les tours montrent ce que vous avez réellement fait ; les tokens et le coût estimé montrent ce que cela a consommé. Les chiffres suivent les mêmes définitions partout, si bien que le tableau de bord et le rapport HTML exporté concordent.

Le plugin est multilingue : le tableau de bord, le rapport HTML, le profil IA et les dialogues de synchronisation suivent la langue d'interface de DSH (8 langues).

## Fonctionnalités

- **Temps de travail et tokens sur la même vue** : temps actif net (temps modèle + temps outils, attente utilisateur exclue), tokens totaux, jours actifs, tours et vitesse de sortie.
- **Par date, espace de travail, modèle et session** : tendance quotidienne, part des espaces de travail, carte proportionnelle des modèles, tendance par modèle, principales sessions et détail par jour.
- **Graphiques** : heatmap calendaire (couleur = temps actif), analyse horaire avec densité de messages humains, vitesse par modèle (tok/s), TTFT et coût estimé pour les modèles ayant un tarif public officiel.
- **Rapport HTML autonome** : un seul fichier, CSS et SVG inline, aucun script ni ressource externe ; thèmes clair / sombre, titre et note personnalisés, option `anonymize=1` pour masquer espaces de travail et titres de sessions — envoyable tel quel à un client.
- **Profil utilisateur IA** : déclenchement manuel uniquement, à partir d'agrégats (jamais le contenu des conversations, les titres ou les chemins) ; repli sur des règles locales si le modèle échoue.
- **Synchronisation multi-appareils** : Tencent COS, GitHub, Gitea ou dossier partagé ; désactivée par défaut, aucune requête sortante sans configuration.
- **8 langues d'interface** : le tableau de bord, le rapport HTML, le profil IA et les dialogues de synchronisation suivent la langue de DSH et basculent en direct.
- **Interfaces officielles uniquement** : aucune analyse des formats de stockage internes ; aucune requête sortante par défaut (profil IA appelé sur clic, solde optionnel désactivé par défaut).

## Installation

```bash
# npm (paquet publié)
dsh plugin add dsh-workload-report

# ou directement depuis GitHub
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

Redémarrez le profil Web après l'installation : l'entrée **Rapport de charge** apparaît **en bas de la barre latérale** et suit la langue de DSH. Le bundle client (`lib/client.js`) est livré avec le paquet : aucune compilation locale n'est nécessaire pour une installation depuis GitHub ou npm.

Pour désinstaller : `dsh plugin --profile web remove dsh-workload-report`.

Prérequis : Node.js ≥ 22.

## Définition des métriques

Le temps actif = temps modèle + temps outils − attente utilisateur (compté séparément) ; les tokens = entrée non cachée + sortie + lecture cache + écriture cache. Toutes les définitions sont détaillées dans [docs/metrics.md](../metrics.md).

Version actuelle : **2.5.0** · 8 langues d'interface · **1738 tests hors ligne** (`node test/verify.mjs`).

## Liens

- [README (anglais)](../../README.md)
- [README (chinois)](./README.zh-CN.md)
- [Définitions des métriques](../metrics.md)
- [Architecture i18n et ajout d'une langue](../i18n.md)
- [Synchronisation multi-appareils](../sync.md)
- [Journal des versions (CHANGELOG)](../../CHANGELOG.md)
- [Article de blog sur vizwise.cn](https://vizwise.cn/posts/dsh-workload-report)
- [Licence MIT](../../LICENSE)

**Mots-clés** : plugin DeepSeek Harness, plugin DSH, rapport de charge, tableau de bord, utilisation des tokens, temps de travail, espace de travail, heatmap calendaire, rapport HTML, synchronisation multi-appareils.
