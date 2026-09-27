const fs = require('node:fs');
const path = require('node:path');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
if (!token) {
	console.error('Не задана переменная окружения BOT_TOKEN.');
	process.exit(1);
}

const webhookUrl = process.env.WEBHOOK_URL?.replace(/\/$/, '');
const webhookPort = Number(process.env.PORT || process.env.WEBHOOK_PORT || 8443);
if (!webhookUrl) {
	console.error('Не задана переменная окружения WEBHOOK_URL.');
	process.exit(1);
}
if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
	console.error('WEBHOOK_PORT должен быть целым числом от 1 до 65535.');
	process.exit(1);
}

const BOT_NAME = 'fakecasinojs';
const dataDirectory = process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDirectory, { recursive: true });
const DATA_FILE = path.join(dataDirectory, 'players.json');
const START_BALANCE = 1000;
const DAILY_BONUS = 500;
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const MAX_BET = 100000;
const SLOTS = ['🍒', '🍋', '🔔', '💎', '7️⃣'];
const GAME_KEYBOARD = {
	keyboard: [
		[{ text: '🎰 Слоты' }, { text: '🏀 Баскетбол' }],
		[{ text: '🪙 Монетка' }],
	],
	resize_keyboard: true,
	is_persistent: true,
	input_field_placeholder: 'Выбери игру',
};
const GAME_BUTTONS = new Map([
	['🎰 Слоты', 'slots'],
	['🏀 Баскетбол', 'basket'],
	['🪙 Монетка', 'flip'],
]);

function loadPlayers() {
	try {
		const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
		return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
	} catch (error) {
		if (error.code !== 'ENOENT') {
			console.error('Не удалось прочитать players.json:', error.message);
		}
		return {};
	}
}

const players = loadPlayers();

function savePlayers() {
	const temporaryFile = `${DATA_FILE}.tmp`;
	fs.writeFileSync(temporaryFile, JSON.stringify(players, null, 2), 'utf8');
	fs.renameSync(temporaryFile, DATA_FILE);
}

function getPlayer(user) {
	const id = String(user.id);
	if (!players[id]) {
		players[id] = {
			name: user.first_name || 'Игрок',
			balance: START_BALANCE,
			lastDaily: 0,
		};
		savePlayers();
	} else if (user.first_name) {
		players[id].name = user.first_name;
	}
	return players[id];
}

function formatBalance(balance) {
	return `${balance.toLocaleString('ru-RU')} фишек`;
}

function parseBet(text, balance) {
	const bet = Number(text);
	if (!Number.isSafeInteger(bet) || bet < 1 || bet > MAX_BET) {
		return { error: `Ставка должна быть целым числом от 1 до ${MAX_BET.toLocaleString('ru-RU')}.` };
	}
	if (bet > balance) {
		return { error: `Не хватает фишек. Баланс: ${formatBalance(balance)}.` };
	}
	return { bet };
}

const bot = new TelegramBot(token, {
	webHook: {
		port: webhookPort,
		autoOpen: false,
	},
});

const pendingGames = new Map();

function getPendingGameKey(message) {
	return `${message.chat.id}:${message.from.id}`;
}

function askForBet(message, game) {
	pendingGames.set(getPendingGameKey(message), { game, stage: 'bet' });
	bot.sendMessage(message.chat.id,
		`Какую ставку поставить? Введи число от 1 до ${MAX_BET.toLocaleString('ru-RU')}.`,
		{ reply_markup: { force_reply: true } });
}

function askForFlipSide(message) {
	bot.sendMessage(message.chat.id, 'На какую сторону ставишь: орёл или решка?',
		{ reply_markup: { force_reply: true } });
}

function playFlip(message, betText, choiceText) {
	const player = getPlayer(message.from);
	const betResult = parseBet(betText, player.balance);
	if (betResult.error) {
		bot.sendMessage(message.chat.id, `${betResult.error}\nПример: /flip 100 орёл`);
		return;
	}

	if (!choiceText) {
		pendingGames.set(getPendingGameKey(message), {
			game: 'flip',
			stage: 'choice',
			bet: betResult.bet,
		});
		askForFlipSide(message);
		return;
	}

	const choice = choiceText.toLowerCase();
	const choices = { 'орёл': 'орёл', 'орел': 'орёл', 'решка': 'решка' };
	if (!choices[choice]) {
		bot.sendMessage(message.chat.id, 'Выбери сторону: орёл или решка. Пример: /flip 100 решка');
		return;
	}

	const result = Math.random() < 0.5 ? 'орёл' : 'решка';
	const won = choices[choice] === result;
	player.balance += won ? betResult.bet : -betResult.bet;
	savePlayers();
	bot.sendMessage(message.chat.id,
		`Выпало: ${result}. ${won ? `Ты выиграл ${formatBalance(betResult.bet)}!` : `Ставка ${formatBalance(betResult.bet)} проиграла.`}\n` +
		`Баланс: ${formatBalance(player.balance)}.`);
}

function playSlots(message, betText) {
	const player = getPlayer(message.from);
	const betResult = parseBet(betText, player.balance);
	if (betResult.error) {
		bot.sendMessage(message.chat.id, `${betResult.error}\nПример: /slots 100`);
		return;
	}

	const result = Array.from({ length: 3 }, () => SLOTS[Math.floor(Math.random() * SLOTS.length)]);
	const pair = result[0] === result[1] || result[1] === result[2] || result[0] === result[2];
	const multiplier = result.every((symbol) => symbol === result[0]) ? 5 : pair ? 2 : 0;
	const payout = multiplier === 5
		? betResult.bet * 5
		: multiplier === 2
			? Math.floor(betResult.bet * 5 / 3)
			: 0;
	player.balance += payout - betResult.bet;
	savePlayers();

	const outcome = multiplier === 5
		? `Три совпадения! Выигрыш: ${formatBalance(payout)}.`
		: multiplier === 2
			? `Есть пара! Выигрыш: ${formatBalance(payout)}.`
			: `Не повезло. Ставка ${formatBalance(betResult.bet)} проиграла.`;
	bot.sendMessage(message.chat.id,
		`${result.join(' | ')}\n${outcome}\nБаланс: ${formatBalance(player.balance)}.`);
}

function playBasket(message, betText) {
	const player = getPlayer(message.from);
	const betResult = parseBet(betText, player.balance);
	if (betResult.error) {
		bot.sendMessage(message.chat.id, `${betResult.error}\nПример: /basket 100`);
		return;
	}

	bot.sendDice(message.chat.id, { emoji: '🏀' })
		.then((sentMessage) => {
			const scored = sentMessage.dice.value >= 4;
			const payout = scored ? Math.floor(betResult.bet * 5 / 2) : 0;
			player.balance += payout - betResult.bet;
			savePlayers();
			const outcome = scored
				? `Попадание! Выигрыш: ${formatBalance(payout)}.`
				: `Промах. Ставка ${formatBalance(betResult.bet)} проиграла.`;
			return bot.sendMessage(message.chat.id,
				`${outcome}\nБаланс: ${formatBalance(player.balance)}.`);
		})
		.catch((error) => {
			console.error('Ошибка баскетбольной игры:', error.message);
		});
}

bot.on('message', (message) => {
	if (!message.text) {
		return;
	}

	const selectedGame = GAME_BUTTONS.get(message.text);
	if (selectedGame) {
		askForBet(message, selectedGame);
		return;
	}

	if (message.text.startsWith('/')) {
		return;
	}

	const key = getPendingGameKey(message);
	const pending = pendingGames.get(key);
	if (!pending) {
		return;
	}

	if (pending.stage === 'bet') {
		const betResult = parseBet(message.text.trim(), getPlayer(message.from).balance);
		if (betResult.error) {
			bot.sendMessage(message.chat.id,
				`${betResult.error} Введи ставку ещё раз числом.`,
				{ reply_markup: { force_reply: true } });
			return;
		}

		pendingGames.delete(key);
		if (pending.game === 'flip') {
			playFlip(message, betResult.bet, pending.choice);
		} else if (pending.game === 'slots') {
			playSlots(message, betResult.bet);
		} else if (pending.game === 'basket') {
			playBasket(message, betResult.bet);
		}
		return;
	}

	if (pending.stage === 'choice') {
		const choice = message.text.trim().toLowerCase();
		if (!['орёл', 'орел', 'решка'].includes(choice)) {
			bot.sendMessage(message.chat.id, 'Напиши «орёл» или «решка».',
				{ reply_markup: { force_reply: true } });
			return;
		}

		pendingGames.delete(key);
		playFlip(message, pending.bet, choice);
	}
});

bot.onText(/\/start(?:@\w+)?/, (message) => {
	const player = getPlayer(message.from);
	bot.sendMessage(message.chat.id,
		`Привет, ${player.name}! Это ${BOT_NAME} — казино с виртуальными фишками.\n` +
		`Стартовый баланс: ${formatBalance(player.balance)}.\n\n` +
		'Команды: /balance, /daily, /flip <ставка> <орёл|решка>, /slots <ставка>, /basket <ставка>, /help',
		{ reply_markup: GAME_KEYBOARD });
});

bot.onText(/\/help(?:@\w+)?/, (message) => {
	bot.sendMessage(message.chat.id,
		'Все фишки в этом боте виртуальные, не покупаются и не выводятся.\n\n' +
		'/balance — посмотреть баланс\n' +
		'/daily — получить бесплатные фишки раз в 24 часа\n' +
		'/flip <ставка> <орёл|решка> — сыграть в монетку\n' +
		'/slots <ставка> — крутить слоты\n' +
		'/basket <ставка> — бросить баскетбольный мяч\n\n' +
		`Ставка: от 1 до ${MAX_BET.toLocaleString('ru-RU')} фишек.`);
});

bot.onText(/\/balance(?:@\w+)?/, (message) => {
	const player = getPlayer(message.from);
	bot.sendMessage(message.chat.id, `Твой баланс: ${formatBalance(player.balance)}.`);
});

bot.onText(/\/daily(?:@\w+)?/, (message) => {
	const player = getPlayer(message.from);
	const now = Date.now();
	const remaining = DAILY_COOLDOWN - (now - player.lastDaily);
	if (remaining > 0) {
		const hours = Math.floor(remaining / (60 * 60 * 1000));
		const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
		bot.sendMessage(message.chat.id, `Бонус уже получен. Попробуй через ${hours} ч. ${minutes} мин.`);
		return;
	}

	player.balance += DAILY_BONUS;
	player.lastDaily = now;
	savePlayers();
	bot.sendMessage(message.chat.id,
		`Начислено ${formatBalance(DAILY_BONUS)}. Баланс: ${formatBalance(player.balance)}.`);
});

bot.onText(/\/flip(?:@\w+)?(?:\s+([^\s]+))?(?:\s+([^\s]+))?/, (message, match) => {
	if (!match[1]) {
		askForBet(message, 'flip');
		return;
	}
	playFlip(message, match[1], match[2]);
});

bot.onText(/\/slots(?:@\w+)?(?:\s+([^\s]+))?/, (message, match) => {
	if (!match[1]) {
		askForBet(message, 'slots');
		return;
	}
	playSlots(message, match[1]);
});

bot.onText(/\/basket(?:@\w+)?(?:\s+([^\s]+))?/, (message, match) => {
	if (!match[1]) {
		askForBet(message, 'basket');
		return;
	}
	playBasket(message, match[1]);
});

bot.on('webhook_error', (error) => {
	console.error('Ошибка Telegram webhook:', error.message);
});

bot.openWebHook()
	.then(() => bot.setWebHook(`${webhookUrl}/bot${token}`))
	.then(() => {
		console.log(`Webhook запущен на порту ${webhookPort}. Используются только виртуальные фишки.`);
	})
	.catch((error) => {
		console.error('Не удалось запустить Telegram webhook:', error.message);
		process.exitCode = 1;
	});
