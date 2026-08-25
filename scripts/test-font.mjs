import { GlobalFonts, createCanvas } from '@napi-rs/canvas';

console.log('has Roboto Test:', GlobalFonts.has('Roboto Test'));
GlobalFonts.registerFromPath('C:/Users/Sahar/AppData/Local/Temp/opencode/roboto.ttf', 'Roboto Test');
console.log('after register has:', GlobalFonts.has('Roboto Test'));

function measure(ch, family) {
	const canvas = createCanvas(200, 200);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, 200, 200);
	ctx.font = `400 120px ${family ? '"Roboto Test"' : '"Arial"'}`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(ch, 10, 150);
	const image = ctx.getImageData(0, 0, 200, 200);
	let minX = 200, minY = 200, maxX = -1, maxY = -1;
	for (let y = 0; y < 200; y++) {
		for (let x = 0; x < 200; x++) {
			const i = (y * 200 + x) * 4;
			const lum = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
			if (lum < 140) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	return { w: maxX - minX + 1, h: maxY - minY + 1 };
}

for (const ch of ['a', 'm', 'i']) {
	const r = measure(ch, true);
	const a = measure(ch, false);
	console.log(`${ch}  Roboto: ${r.w}x${r.h} aspect=${(r.w / r.h).toFixed(2)}   Arial: ${a.w}x${a.h} aspect=${(a.w / a.h).toFixed(2)}`);
}