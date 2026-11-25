import { t, tn } from "./i18n";
import { FIELDS, OPS, defaultCondition, type Condition, type Field, type Rule } from "./rules";

/** Named palette; the backend only accepts these keys. */
export const TAG_COLORS: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#ec4899",
  gray: "#8b8b98",
};

export const tagColor = (key: string) => TAG_COLORS[key] ?? TAG_COLORS.gray;

export interface TagDraft {
  name: string;
  color: string;
  rule: Rule | null;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/**
 * Opens the tag editor. `count` returns how many families a rule currently matches,
 * shown live while editing a smart tag.
 */
export function editTag(
  title: string,
  initial: TagDraft,
  count: (rule: Rule) => number,
  classes: Record<string, string>,
): Promise<TagDraft | null> {
  const dialog = byId<HTMLDialogElement>("tag-dialog");
  const name = byId<HTMLInputElement>("tag-name");
  const match = byId<HTMLSelectElement>("tag-match");
  const list = byId<HTMLDivElement>("tag-conditions");
  const counter = byId<HTMLParagraphElement>("tag-count");
  const swatches = byId<HTMLDivElement>("tag-colors");

  byId("tag-title").textContent = title;
  byId("tag-rule").hidden = !initial.rule;
  name.value = initial.name;
  let color = initial.color;
  const rule: Rule = initial.rule
    ? { match: initial.rule.match, conditions: initial.rule.conditions.map((c) => ({ ...c })) }
    : { match: "all", conditions: [] };
  if (initial.rule && !rule.conditions.length) rule.conditions.push(defaultCondition());
  match.value = rule.match;

  const drawSwatches = () => {
    swatches.replaceChildren(
      ...Object.entries(TAG_COLORS).map(([key, hex]) => {
        const b = el("button", { type: "button", className: `swatch${key === color ? " on" : ""}`, title: key });
        b.style.background = hex;
        b.onclick = () => {
          color = key;
          drawSwatches();
        };
        return b;
      }),
    );
  };

  const updateCount = () => {
    const n = count(rule);
    counter.textContent = rule.conditions.length ? tn(n, "{n} family currently matches.", "{n} families currently match.") : t("Add a condition.");
  };

  const drawConditions = () => {
    list.replaceChildren(
      ...rule.conditions.map((c, i) => {
        const kind = FIELDS[c.field].kind;
        const field = el(
          "select",
          {},
          Object.entries(FIELDS).map(([key, f]) => el("option", { value: key, textContent: t(f.label), selected: key === c.field })),
        );
        field.onchange = () => {
          rule.conditions[i] = defaultCondition(field.value as Field);
          drawConditions();
        };
        const op = el(
          "select",
          {},
          OPS[kind].map((o) => el("option", { value: o.op, textContent: t(o.label), selected: o.op === c.op })),
        );
        op.onchange = () => {
          c.op = op.value as Condition["op"];
          updateCount();
        };

        let value: HTMLElement | null = null;
        if (kind === "enum") {
          const select = el(
            "select",
            {},
            Object.entries(classes).map(([key, label]) => el("option", { value: key, textContent: label, selected: key === c.value })),
          );
          select.onchange = () => {
            c.value = select.value;
            updateCount();
          };
          value = select;
        } else if (kind !== "bool") {
          const input = el("input", {
            type: kind === "number" || kind === "days" ? "number" : "text",
            value: c.value,
            placeholder: kind === "text" ? t("text") : kind === "tag" ? "smcp" : t("value"),
          });
          input.oninput = () => {
            c.value = input.value;
            updateCount();
          };
          value = input;
        }

        const remove = el("button", { type: "button", className: "icon", textContent: "−", title: t("Remove the condition") });
        remove.onclick = () => {
          rule.conditions.splice(i, 1);
          drawConditions();
        };
        return el("div", { className: "condition" }, [field, op, value ?? el("span"), remove]);
      }),
    );
    updateCount();
  };

  match.onchange = () => {
    rule.match = match.value === "any" ? "any" : "all";
    updateCount();
  };
  byId("tag-add-condition").onclick = () => {
    rule.conditions.push(defaultCondition());
    drawConditions();
  };

  drawSwatches();
  drawConditions();
  dialog.returnValue = ""; // otherwise Escape would reuse the previous answer
  dialog.showModal();
  name.select();

  // A single handler (not addEventListener) so an earlier opening can never answer for this one.
  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.onclose = null;
      const ok = dialog.returnValue === "ok" && name.value.trim();
      resolve(ok ? { name: name.value.trim(), color, rule: initial.rule ? rule : null } : null);
    };
  });
}
