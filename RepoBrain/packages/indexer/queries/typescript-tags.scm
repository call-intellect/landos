; RepoBrain tags query — TypeScript / TSX (defs + refs, heuristic call-graph).
; Kept to node types stable across grammar versions; validated against the bundled wasm.

; ── definitions ──
(function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

(class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.enum

(public_field_definition
  name: (property_identifier) @name) @definition.field

(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function

(variable_declarator
  name: (identifier) @name) @definition.variable

; ── references (heuristic) ──
(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.call

(new_expression
  constructor: (identifier) @name) @reference.class
