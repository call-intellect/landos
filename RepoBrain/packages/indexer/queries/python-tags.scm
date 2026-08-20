; RepoBrain tags query — Python (defs + refs, heuristic call-graph).

; ── definitions ──
(function_definition
  name: (identifier) @name) @definition.function

(class_definition
  name: (identifier) @name) @definition.class

; ── references (heuristic) ──
(call
  function: (identifier) @name) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name)) @reference.call
