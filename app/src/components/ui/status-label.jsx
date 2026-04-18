function Spinner( { size } ) {

	const r = ( size - 1 ) / 2;
	const cx = size / 2;
	const cy = size / 2;

	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			fill="none"
			className="shrink-0 animate-[spin_0.9s_linear_infinite]"
		>
			<circle
				cx={cx} cy={cy} r={r}
				strokeWidth="1.5"
				className="stroke-muted-foreground/30"
			/>
			<path
				d={`M${cx} ${cy - r}A${r} ${r} 0 0 1 ${cx + r} ${cy}`}
				strokeWidth="1.5"
				strokeLinecap="round"
				className="stroke-blue-400"
			/>
		</svg>
	);

}

export function StatusLabel( { label, percent, onCancel } ) {

	return (
		<span className="inline-flex items-center gap-2 rounded-full font-mono text-xs font-medium whitespace-nowrap bg-background border border-border text-foreground px-3 py-1.5">

			<span
				className="shrink-0 size-2 rounded-full"
				style={{ animation: 'toggle-green 1s step-end infinite' }}
			/>

			<span>{label}</span>

			{percent !== undefined && (
				<span className="shrink-0 rounded-full font-mono text-[10px] font-medium leading-none px-1.5 py-px bg-blue-500/15 text-blue-400">
					{Math.round( percent )}%
				</span>
			)}

			<Spinner size={12} />

			{onCancel && (
				<button
					className="shrink-0 -mr-1 p-0.5 rounded-full hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
					onClick={onCancel}
					title="Cancel"
				>
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
						<path d="M2 2l6 6M8 2l-6 6" />
					</svg>
				</button>
			)}

		</span>
	);

}
