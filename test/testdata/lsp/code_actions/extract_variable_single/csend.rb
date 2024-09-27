# typed: true
# selective-apply-code-action: refactor.extract
# enable-experimental-lsp-extract-to-variable: true

def foo(x)
end

a = T.unsafe(1)
a_ = a&.to_s
#    ^ apply-code-action: [A] Extract Variable (this occurrence only)

b = T.unsafe(1)
foo(b&.foo) do
#   ^ apply-code-action: [B] Extract Variable (this occurrence only)
  c = T.unsafe(1)
  c&.foo
# ^ apply-code-action: [C] Extract Variable (this occurrence only)
  d = T.unsafe(1)
  d_ = (d&.foo)&.bar
#       ^^^^^^  apply-code-action: [D] Extract Variable (this occurrence only)
  e = T.unsafe(1)
  e_ = (e&.foo)&.bar
#       ^ apply-code-action: [E] Extract Variable (this occurrence only)
  T.unsafe(if T.unsafe(1) then 2 else 3 end)&.bar
#                              ^ apply-code-action: [F] Extract Variable (this occurrence only)
  f = T.unsafe(1)
  d = T.unsafe(while T.unsafe(1); f_ = f&.foo end)&.bar
#                                      ^ apply-code-action: [G] Extract Variable (this occurrence only)
end

