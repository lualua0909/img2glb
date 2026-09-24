"use client"

import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-200 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-4 focus-visible:ring-ring/25 aria-invalid:border-destructive data-[size=default]:h-[26px] data-[size=default]:w-[44px] data-[size=sm]:h-5 data-[size=sm]:w-8 data-checked:bg-success data-unchecked:bg-[rgb(120_120_128/0.2)] data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.18),0_0_0_0.5px_rgba(0,0,0,0.04)] ring-0 transition-transform duration-200 group-data-[size=default]/switch:size-[22px] group-data-[size=sm]/switch:size-4 group-data-[size=default]/switch:data-checked:translate-x-[20px] group-data-[size=sm]/switch:data-checked:translate-x-[14px] data-unchecked:translate-x-[2px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
