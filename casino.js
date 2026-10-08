const fs = require('node:fs');
const path = require('node:path');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
if (!token) {
	console.error('Не задана переменная окружения BOT_TOKEN.');
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
const SLOT_SYMBOLS = ['BAR', '🍇', '🍋', '7️⃣'];
const SLOT_TRIPLE_PAYOUTS = new Map([
	[0, { name: 'BAR', multiplier: 20 }],
	[1, { name: '🍇', multiplier: 30 }],
	[2, { name: '🍋', multiplier: 50 }],
	[3, { name: '777', multiplier: 100 }],
]);
const GAME_KEYBOARD = {
	keyboard: [
		[{ text: '🎰 Слоты' }, { text: '🏀 Баскетбол' }],
		[{ text: '🪙 Монетка' }],
	],
	resize_keyboard: true,
	one_time_keyboard: false,
	is_persistent: true,
	input_field_placeholder: 'Выбери игру',
};
const BET_KEYBOARD = {
	keyboard: [
		[{ text: '50' }, { text: '100' }, { text: '200' }],
		[{ text: '500' }, { text: '1000' }],
		[{ text: '✏️ Своя ставка' }],
		[{ text: '⬅️ Игры' }],
	],
	resize_keyboard: true,
	one_time_keyboard: false,
	is_persistent: true,
	input_field_placeholder: 'Выбери или введи ставку',
};
const FLIP_KEYBOARD = {
	keyboard: [
		[{ text: 'Орёл' }, { text: 'Решка' }],
		[{ text: '⬅️ Игры' }],
	],
	resize_keyboard: true,
	one_time_keyboard: false,
	is_persistent: true,
	input_field_placeholder: 'Выбери сторону',
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

function getSlotTriple(value) {
	if (!Number.isInteger(value) || value < 1 || value > 64) {
		throw new Error(`Некорректное значение результата слотов: ${value}`);
	}

	const roll = value - 1;
	const reels = [0, 1, 2].map((reel) => Math.floor(roll / (4 ** reel)) % 4);
	if (!reels.every((symbol) => symbol === reels[0])) {
		return null;
	}

	return { ...SLOT_TRIPLE_PAYOUTS.get(reels[0]), symbol: SLOT_SYMBOLS[reels[0]] };
}

const bot = new TelegramBot(token, { polling: { autoStart: false } });

const pendingGames = new Map();

function getPendingGameKey(message) {
	return `${message.chat.id}:${message.from.id}`;
}

function askForBet(message, game) {
	pendingGames.set(getPendingGameKey(message), { game, stage: 'bet' });
	bot.sendMessage(message.chat.id,
		`Выбери ставку или нажми «Своя ставка» и введи число от 1 до ${MAX_BET.toLocaleString('ru-RU')}.`,
		{ reply_markup: BET_KEYBOARD });
}

function askForFlipSide(message) {
	bot.sendMessage(message.chat.id, 'На какую сторону ставишь: орёл или решка?',
		{ reply_markup: FLIP_KEYBOARD });
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
		bot.sendMessage(message.chat.id, 'Выбери сторону: орёл или решка. Пример: /flip 100 решка',
			{ reply_markup: FLIP_KEYBOARD });
		return;
	}

	const result = Math.random() < 0.5 ? 'орёл' : 'решка';
	const won = choices[choice] === result;
	player.balance += won ? betResult.bet : -betResult.bet;
	savePlayers();
	bot.sendMessage(message.chat.id,
		`Выпало: ${result}. ${won ? `Ты выиграл ${formatBalance(betResult.bet)}!` : `Ставка ${formatBalance(betResult.bet)} проиграла.`}\n` +
		`Баланс: ${formatBalance(player.balance)}.`,
		{ reply_markup: GAME_KEYBOARD });
}

function playSlots(message, betText) {
	const player = getPlayer(message.from);
	const betResult = parseBet(betText, player.balance);
	if (betResult.error) {
		bot.sendMessage(message.chat.id, `${betResult.error}\nПример: /slots 100`);
		return;
	}

	bot.sendDice(message.chat.id, { emoji: '🎰' })
		.then((sentMessage) => {
			const triple = getSlotTriple(sentMessage.dice.value);
			const payout = triple ? betResult.bet * triple.multiplier : 0;
			player.balance += payout - betResult.bet;
			savePlayers();

			const outcome = triple
				? `Три ${triple.name}! Выплата ×${triple.multiplier}: ${formatBalance(payout)}.`
				: `Тройки нет. Ставка ${formatBalance(betResult.bet)} проиграла.`;
			return bot.sendMessage(message.chat.id,
				`${outcome}\nБаланс: ${formatBalance(player.balance)}.`,
				{ reply_markup: GAME_KEYBOARD });
		})
		.catch((error) => {
			console.error('Ошибка игры в слоты:', error.message);
		});
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
				`${outcome}\nБаланс: ${formatBalance(player.balance)}.`,
				{ reply_markup: GAME_KEYBOARD });
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

	const key = getPendingGameKey(message);
	const pending = pendingGames.get(key);
	if (message.text === '⬅️ Игры') {
		pendingGames.delete(key);
		bot.sendMessage(message.chat.id, 'Выбери игру:', { reply_markup: GAME_KEYBOARD });
		return;
	}

	if (message.text.startsWith('/')) {
		return;
	}

	if (!pending) {
		return;
	}

	if (pending.stage === 'bet' && message.text === '✏️ Своя ставка') {
		pending.stage = 'customBet';
		bot.sendMessage(message.chat.id,
			`Введи ставку числом от 1 до ${MAX_BET.toLocaleString('ru-RU')}.`,
			{ reply_markup: BET_KEYBOARD });
		return;
	}

	if (pending.stage === 'bet' || pending.stage === 'customBet') {
		const betResult = parseBet(message.text.trim(), getPlayer(message.from).balance);
		if (betResult.error) {
			bot.sendMessage(message.chat.id,
				`${betResult.error} Выбери ставку или введи другое число.`,
				{ reply_markup: BET_KEYBOARD });
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
				{ reply_markup: FLIP_KEYBOARD });
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
		`Ставка: от 1 до ${MAX_BET.toLocaleString('ru-RU')} фишек.`,
		{ reply_markup: GAME_KEYBOARD });
});

bot.onText(/\/balance(?:@\w+)?/, (message) => {
	const player = getPlayer(message.from);
	bot.sendMessage(message.chat.id, `Твой баланс: ${formatBalance(player.balance)}.`,
		{ reply_markup: GAME_KEYBOARD });
});

bot.onText(/\/daily(?:@\w+)?/, (message) => {
	const player = getPlayer(message.from);
	const now = Date.now();
	const remaining = DAILY_COOLDOWN - (now - player.lastDaily);
	if (remaining > 0) {
		const hours = Math.floor(remaining / (60 * 60 * 1000));
		const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
		bot.sendMessage(message.chat.id, `Бонус уже получен. Попробуй через ${hours} ч. ${minutes} мин.`,
			{ reply_markup: GAME_KEYBOARD });
		return;
	}

	player.balance += DAILY_BONUS;
	player.lastDaily = now;
	savePlayers();
	bot.sendMessage(message.chat.id,
		`Начислено ${formatBalance(DAILY_BONUS)}. Баланс: ${formatBalance(player.balance)}.`,
		{ reply_markup: GAME_KEYBOARD });
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

bot.on('polling_error', (error) => {
	console.error('Ошибка Telegram polling:', error.message);
});

bot.deleteWebHook()
	.then(() => bot.startPolling())
	.then(() => {
		console.log('Бот запущен на компьютере через polling. Используются только виртуальные фишки.');
	})
	.catch((error) => {
		console.error('Не удалось запустить бота:', error.message);
		process.exitCode = 1;
	});
