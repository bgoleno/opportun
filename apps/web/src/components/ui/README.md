# Vendored UI primitives

These components are copied from [shadcn/ui](https://ui.shadcn.com) (MIT License,
Copyright (c) 2023 shadcn) and adapted for this app. They are owned source, not a
dependency: edit them here.

Adaptations for the server's strict Content Security Policy (`default-src 'self'`, no
inline styles or scripts):

- `dialog.tsx` is built on the native `<dialog>` element instead of Radix Dialog. Radix
  Dialog locks scrolling by injecting a `<style>` tag, which the CSP blocks.
- `select.tsx` is a styled native `<select>` (shadcn's native-select) instead of Radix
  Select, which also injects a `<style>` tag.
- `dropdown-menu.tsx` defaults `modal={false}` for the same reason (modal Radix menus
  inject the scroll-lock style).
- `toast.tsx` uses Radix Toast (no injected styles) with a small module-level store in
  place of sonner, which injects its stylesheet at runtime.
