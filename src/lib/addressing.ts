/**
 * Datasheet numbering vs wire address.
 *
 * Internally every address is the 0-based wire address — that rule doesn't
 * bend. But nobody's datasheet is written that way: vendors print 40101, or
 * 30101, or 101. Making the user do that subtraction in their head is the
 * single most common way a meter ends up reading the wrong register, so the
 * editor asks which numbering their sheet uses and converts.
 *
 * See docs/reference/modbus-primer.md.
 */

export type AddressBase = "holding4x" | "input3x" | "oneBased" | "zeroBased";

type BaseSpec = {
  value: AddressBase;
  label: string;
  hint: string;
  /** What to add to a wire address to get the displayed number. */
  offset: number;
};

export const ADDRESS_BASES: BaseSpec[] = [
  {
    value: "holding4x",
    label: "40001 style",
    hint: "Holding registers written as 4xxxx — the most common on meter datasheets",
    offset: 40001,
  },
  {
    value: "input3x",
    label: "30001 style",
    hint: "Input registers written as 3xxxx",
    offset: 30001,
  },
  {
    value: "oneBased",
    label: "1-based",
    hint: "Plain numbering that starts at 1",
    offset: 1,
  },
  {
    value: "zeroBased",
    label: "0-based (wire)",
    hint: "The raw address that goes on the wire — starts at 0",
    offset: 0,
  },
];

function offsetFor(base: AddressBase): number {
  return ADDRESS_BASES.find((b) => b.value === base)?.offset ?? 0;
}

/** Datasheet number -> 0-based wire address, clamped to the address space. */
export function toWire(displayed: number, base: AddressBase): number {
  const wire = Math.round(displayed) - offsetFor(base);
  return Math.min(0xffff, Math.max(0, wire));
}

/** 0-based wire address -> the number the user's datasheet would print. */
export function fromWire(wire: number, base: AddressBase): number {
  return wire + offsetFor(base);
}

/**
 * Both numbers, always shown together. A reader who thinks in one notation can
 * check the other at a glance rather than trusting the conversion silently.
 */
export function describeAddress(wire: number, base: AddressBase): string {
  if (base === "zeroBased") return `${wire}`;
  return `${fromWire(wire, base)} (wire ${wire})`;
}

/** The function code implied by a 4xxxx / 3xxxx datasheet, if any. */
export function functionForBase(
  base: AddressBase,
): "read_holding_registers" | "read_input_registers" | null {
  if (base === "holding4x") return "read_holding_registers";
  if (base === "input3x") return "read_input_registers";
  return null;
}
