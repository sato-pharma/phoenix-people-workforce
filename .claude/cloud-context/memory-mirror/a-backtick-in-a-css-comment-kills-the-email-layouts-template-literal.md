---
name: a-backtick-in-a-css-comment-kills-the-email-layouts-template-literal
description: A backtick written inside a CSS comment in src/emails/phoenix-email-layout.tsx terminates the template literal and the file dies with ERR_INVALID_TYPESCRIPT_SYNTAX, nowhere near the comment
metadata:
  type: reference
---

**A CSS comment inside a template literal is not a safe place for a backtick.** Measured
2026-10-09 in `src/emails/phoenix-email-layout.tsx` (PR 5631): a `/* … */` note inside the
layout's `<style>` template literal quoted a class name in backticks, as every other comment in
this repo does. CSS comments mean nothing to the JavaScript lexer, so the backtick CLOSED the
template literal and the file failed to parse — `ERR_INVALID_TYPESCRIPT_SYNTAX`, reported at a
line far from the comment, which reads as a syntax error in the code you just wrote.

**How to apply:** inside a template literal, write comment prose with no backticks at all — plain
words, or single quotes. The rule holds for the `<style>` block, for any generated SQL or HTML
template literal, and for a comment a later session adds to one. Related:
[[the-edit-tool-cannot-match-a-line-holding-arabic-or-an-escape]].
