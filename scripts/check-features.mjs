import { GlobalFonts, createCanvas } from '@napi-rs/canvas';

GlobalFonts.registerFromPath('C:/Users/Sahar/OneDrive/Desktop/websites/fontsfinder.com/.fonts-cache/roboto.woff2', 'FF-roboto');
GlobalFonts.registerFromPath('C:/Users/Sahar/OneDrive/Desktop/websites/fontsfinder.com/.fonts-cache/pacifico.woff2', 'FF-pacifico');

function measure(label, fontStr) {
	const canvas = createCanvas(200, 200);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, 200, 200);
	ctx.font = fontStr;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText('a', 10, 150);
	const img = ctx.getImageData(0, 0, 200, 200);
	let minX = 200, minY = 200, maxX = -1, maxY = -1;
	for (let y = 0; y < 200; y++) {
		for (let x = 0; x < 200; x++) {
			const i = (y * 200 + x) * 4;
			const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
			if (lum < 140) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	console.log(`${label}: ${maxX - minX + 1}x${maxY - minY + 1} aspect=${((maxX - minX + 1) / (maxY - minY + 1)).toFixed(2)}`);
}

measure('roboto  "400 110px FF-roboto"', '400 110px "FF-roboto"');
measure('roboto  110px FF-roboto', '110px FF-roboto');
measure('pacifico 110px FF-pacifico', '110px FF-pacifico');
measure('roboto  110px "FF-roboto"', '110px "FF-roboto"');
measure('roboto  400 110px sans-serif', '400 110px sans-serif');
measure('roboto  110px sans-serif', '110px sans-serif');