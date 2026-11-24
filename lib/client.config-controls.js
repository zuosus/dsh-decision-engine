// Editable source embedded in client.js by scripts/build-client.mjs.
// Preserve native controls and their handlers; associate each field with its row.
function associateConfigControl(node, labelId, hintId) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => associateConfigControl(child, labelId, hintId));
  const props = node.props ?? {};
  const isInput = ["input", "select", "textarea"].includes(node.type);
  const isToggle = node.type === "button" && Object.hasOwn(props, "aria-pressed");
  const associated = isInput || isToggle ? {
    "aria-labelledby": labelId,
    ...(hintId ? { "aria-describedby": hintId } : {}),
  } : {};
  // React elements use props.children; the test renderer retains children separately.
  const rawChildren = props.children ?? node.children;
  const children = rawChildren === undefined ? [] : (Array.isArray(rawChildren) ? rawChildren : [rawChildren]);
  return h(node.type, { ...props, ...associated },
    ...children.map((child) => associateConfigControl(child, labelId, hintId)));
}

function configRow(title, hint, control, key, note, beforeHint) {
  const labelId = `de-cfg-field-${key}`;
  const hintId = hint == null ? undefined : `${labelId}-hint`;
  return h("div", { className: "de-cfg__row", "data-field": key, style: S.rowLine, key },
    h("div", { className: "de-cfg__text", style: S.rowText },
      h("div", { id: labelId, className: "de-cfg__label", style: S.rowTitle }, title),
      associateConfigControl(beforeHint, labelId, hintId),
      hintId ? h("div", { id: hintId, className: "de-cfg__hint", style: S.rowHint }, hint) : null,
      note == null ? null : h("div", { className: "de-cfg__note", style: S.rowNote }, note)),
    h("div", { className: "de-cfg__control" }, associateConfigControl(control, labelId, hintId)));
}
