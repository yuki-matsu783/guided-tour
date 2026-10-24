---
title: Markdown（設計書）
type: adr
description: markdown-it（`html: false`）のトークンから、許可リストに沿って DOM を組み立てる
tags: [adr]
keywords: [Markdown]
---

# ADR-0063: Markdown（設計書）

状態: 採用

## 決めたこと

markdown-it（`html: false`）のトークンから、許可リストに沿って DOM を組み立てる

## 理由

innerHTML を使わずに安全に表示するため
