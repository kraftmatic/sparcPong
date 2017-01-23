var express = require('express');
var router = express.Router();
var mongoose = require('mongoose');
var Challenge = mongoose.model('Challenge');
var Player = mongoose.model('Player');
var Team = mongoose.model('Team');
var Mailer = require('../Mailer');
var Util = require('../Util');


/* POST new challenge
 *
 * @param: challengerId
 * @param: challengeeId
 */
router.post('/', function(req, res, next) {
	var challenge = new Challenge();
	var challengerId = req.body.challengerId;
	var challengeeId = req.body.challengeeId;
	challenge.challenger = challengerId;
	challenge.challengee = challengeeId;
	
	if (!challengerId || !challengeeId)
		return next(new Error('Two players are required for a challenge.'));
	if (challengerId == challengeeId)
		return next(new Error('Players cannot challenge themselves.'));
	
	// Not allowed to issue challenges on weekends
	var todayDay = new Date().getDay();
	var CHALLENGE_ANYTIME = process.env.CHALLENGE_ANYTIME || false;
	if ((todayDay == 0 || todayDay == 6) && !CHALLENGE_ANYTIME)
		return next(new Error('You can only issue challenges on business days.'));
	
	challengeExists(challengerId, challengeeId, function(err) {
		if (err) return next(err);
		
		// Grabs player info on both challenge participants
		Player.findById(challengerId).exec(function(err, challenger) {
			if (err) return next(err);
			Player.findById(challengeeId).exec(function(err, challengee) {
				if (err) return next(err);
				
				// Verifies the challenge can be issued and received
				allowedToChallenge(challenger, challengee, function(err) {
					if (err) return next(err);
					
					if (challenger.rank < challengee.rank)
						return next(new Error('You cannot challenger a player below your rank.'));
					else if (Math.abs(Util.getTier(challenger.rank) - Util.getTier(challengee.rank)) > 1)
						return next(new Error('You cannot challenge a player beyond 1 tier.'));
					
					challenge.save(function(err) {
						if (err) return next(err);
						Mailer.newChallenge(challenger, challengee);
						req.app.io.sockets.emit('challenge:issued', { challenger: { username: challenger.username,
																					rank: challenger.rank },
																	  challengee: { username: challengee.username,
																					rank: challengee.rank }});
						res.json({message: 'Challenge issued!'});
					});
				});
			});
		});
	});	
});


/* GET all challenges involving a player
 * 
 * @param: playerId
 * @return: message.resolved
 * @return: message.outgoing
 * @return: message.incoming
 */
router.get('/:playerId', function(req, res, next) {
	var playerId = req.params.playerId;
	if (!playerId) {
		console.log(challengeId + ' is not a valid player id.');
		return next(new Error('This is not a valid player.'));
	}
	
	// Resolved
	Challenge.find({ $and: [
						{$or: [{'challenger': playerId}, {'challengee': playerId}]}, 
						{'winner': {$ne: null}}
					]})
					.populate('challenger challengee')
					.exec(function(err, challenges) {
		if (err) return next(err);
		var resolved = challenges;
		
		// Outgoing
		Challenge.find({challenger: playerId, winner: null})
						.populate('challenger challengee')
						.exec(function(err, challenges) {
			if (err) return next(err);
			var outgoing = challenges;
			
			// Incoming
			Challenge.find({challengee: playerId, winner: null})
							.populate('challenger challengee')
							.exec(function(err, challenges) {
				if (err) return next(err);
				var incoming = challenges;
				
				res.json({message: {resolved: resolved, outgoing: outgoing, incoming: incoming}});
			});
		});
	});
});


/* DELETE wrongly issued challenge by challengerId
 *
 * @param: challengerId
 */
router.delete('/revoke', function(req, res, next) {
	var challengerId = req.body.challengerId;
	var challengeeId = req.body.challengeeId;
	
	if (!challengerId || !challengeeId)
		return next(new Error('Both players are required to revoke a challenge.'));
	
	// Checks for forfeit
	Challenge.find({challenger: challengerId, challengee: challengeeId, winner: null}).populate('challenger challengee').exec(function(err, challenges) {
		if (err) return next(err);
		if (!challenges || challenges.length == 0)
			return next(new Error('Could not find the challenge.'));
		
		var challenger = challenges[0].challenger;
		var challengee = challenges[0].challengee;
		
		if (hasForfeit(challenges[0].createdAt))
			return next(new Error('This challenge has expired. '+challengee.username+' must forfeit.'));
		
		Challenge.remove({challenger: challengerId, challengee: challengeeId, winner: null}, function(err, challenges) {
			if (err) return next(err);
			
			if (challenges.result && challenges.result.n) {
				Mailer.revokedChallenge(challenger, challengee);
				req.app.io.sockets.emit('challenge:revoked', { challenger: {username: challenger.username}, challengee: {username: challengee.username} });
				res.json({message: 'Successfully revoked challenge.'});
			} else {
				return next(new Error('Could not find the challenge.'));
			}
		});
	});
});

/* POST resolved challenge by adding a score and winner
 *
 * @param: challengeId
 * @param: challengerScore
 * @param: challengeeScore
 */
router.post('/resolve', function(req, res, next) {
	var challengeId = req.body.challengeId;
	var challengerScore = req.body.challengerScore;
	var challengeeScore = req.body.challengeeScore;
	
	if (!challengeId) {
		console.log(challengeId + ' is not a valid challenge id.');
		return next(new Error('This is not a valid challenge.'));
	}
	if (challengerScore == null || challengeeScore == null || challengerScore < 0 || challengeeScore < 0 || challengerScore + challengeeScore < 2)
		return next(new Error('You must give valid scores for both players.'));
	if (challengerScore == challengeeScore)
		return next(new Error('The final score cannot be equal.'));
	
	Challenge.findById(challengeId).populate('challenger challengee').exec(function(err, challenge) {
		if (err) return next(err);
		
		if (hasForfeit(challenge.createdAt)) {
			return next(new Error('This challenge has expired. '+challenge.challengee.username+' must forfeit.'));
		} else {
			console.log('Resolving challenge id ['+challengeId+']');
		}
		
		var winner = challengerScore > challengeeScore ? challenge.challenger : challenge.challengee;
		var loser  = challengerScore < challengeeScore ? challenge.challenger : challenge.challengee;
		
		challenge.winner = winner._id;
		challenge.challengerScore = challengerScore;
		challenge.challengeeScore = challengeeScore;
		challenge.save();
		
		updateLastGames(challenge, function(err) {
			if (err) return next(err);
			swapRanks(winner, loser, function(err, swapped) {
				if (err) return next(err);
                Mailer.resolvedChallenge(winner, loser);
				req.app.io.sockets.emit('challenge:resolved', { winner: {username: winner.username}, loser: {username: loser.username} });
				res.json({message: 'Successfully resolved challenge.'});
			});
		});
	});
});

/*
 * Forfeits an expired challenge.
 *
 * @param: challengeId
 */
router.post('/forfeit', function(req, res, next) {
	var challengeId = req.body.challengeId;
	if (!challengeId)
		return next(new Error('This is not a valid challenge id.'));
	Challenge.findById(challengeId).populate('challenger challengee').exec(function(err, challenge) {
		if (err) return next(err);
	
		console.log('Forfeiting challenge id ['+challengeId+']');
		
		// Challenger wins in the event of a forfeit
		var winner = challenge.challenger;
		var loser = challenge.challengee;
		challenge.winner = winner._id;
		challenge.save();
		
		updateLastGames(challenge, function(err) {
			if (err) return next(err);
			swapRanks(winner, loser, function(err, swapped) {
				if (err) return next(err);
				Mailer.forfeitedChallenge(challenge.challenger, challenge.challengee);
				req.app.io.sockets.emit('challenge:forfeited', { challenger: {username: challenge.challenger.username}, challengee: {username: challenge.challengee.username} });
				res.json({message: 'Challenge successfully forfeited.'});
			});
		});
	});
});


/*
 * Determines if an open challenge between two players exists.
 *
 * @param: playerId1
 * @param: playerId2
 *
 * @return: err
 * @return: boolean - true if challenges exist, false if none exist
 */
function challengeExists(playerId1, playerId2, callback) {
	Challenge.find({$or: [ 
						{$and: [{challenger: playerId1}, {challengee: playerId2}, {winner: null}]}, 
						{$and: [{challenger: playerId2}, {challengee: playerId1}, {winner: null}]}
					]}, function(err, challenges) {
		
		if (err) {
			callback(err);
		} else if (challenges.length > 0){
			callback(new Error('A challenge already exists between these players.'));
		} else {
			callback(null);
		}
	});
}

/*
 * Determines if the given challenge issue date should be forfeited.
 *
 * @param: dateIssued - date the challenge was issued
 */
var ALLOWED_CHALLENGE_DAYS = process.env.ALLOWED_CHALLENGE_DAYS || 4;
function hasForfeit(dateIssued) {
	var expires = Util.addBusinessDays(dateIssued, ALLOWED_CHALLENGE_DAYS);
	// Challenge expired before today
	return expires < new Date();
}


/*
 * Determines if a given player is eligible to issue challenges.
 *
 * @param: playerId
 *
 * @return: err
 * @return: boolean - true if allowed, and false if not allowed
 * @return: String - error message if not allowed
 */
var ALLOWED_OUTGOING = process.env.ALLOWED_OUTGOING || 1;
var ALLOWED_INCOMING = process.env.ALLOWED_INCOMING || 1;
function allowedToChallenge(challenger, challengee, callback) {
	// Checks challenger
	countChallenges(challenger._id, function(err, incoming, outgoing) {
		if (err) {
			callback(err);
			return;
		} else if (incoming >= ALLOWED_INCOMING) {
			callback(new Error(challenger.username +' cannot have more than '+ALLOWED_INCOMING+' incoming challenge.'));
			return;
		} else if (outgoing >= ALLOWED_OUTGOING) {
			callback(new Error(challenger.username +' cannot have more than '+ALLOWED_OUTGOING+' outgoing challenge.'));
			return;
		}
		// Checks challengee
		countChallenges(challengee._id, function(err, incoming, outgoing) {
			if (err) {
				callback(err);
				return;
			} else if (incoming >= ALLOWED_INCOMING) {
				callback(new Error(challengee.username +' cannot have more than '+ALLOWED_INCOMING+' incoming challenge.'));
				return;
			} else if (outgoing >= ALLOWED_OUTGOING) {
				callback(new Error(challengee.username +' cannot have more than '+ALLOWED_OUTGOING+' outgoing challenge.'));
				return;
			} else {
				// Checks for no "challenge-back" delay
				console.log('Checking for recently resolved challenges.');
				getResolvedChallenges(challenger, challengee, function(err, challenges) {
					if (err) {
						callback(err);
						return;
					}
					// Get most recent challenge
					challenges.sort(function(a, b) {
						if (a.updatedAt > b.updatedAt) return -1;
						else return 1;
					});
					if (challenges && challenges[0]) {
						var CHALLENGE_BACK_DELAY_HOURS = process.env.CHALLENGE_BACK_DELAY_HOURS || 4;
						var reissueTime = Util.addHours(challenges[0].updatedAt, CHALLENGE_BACK_DELAY_HOURS);
						var canReissue = reissueTime < new Date();
						if (!canReissue) {
							callback(new Error('You must wait at least '+ CHALLENGE_BACK_DELAY_HOURS +' hours before re-challenging the same player.'));
							return;
						}
					}
					// Did not find any challenge history
					callback(null);
				});
			}
		});
	});
}

/*
 * Counts incoming and outgoing challenges for a given player.
 *
 * @param: playerId
 *
 * @return: incoming challenges
 * @return: outgoing challenges
 */
function countChallenges(playerId, callback) {
	Challenge.find({challenger: playerId, winner: null}, function(err, challenges) {
		if (err) {
			callback(err);
			return;
		}
		var outgoing = challenges ? challenges.length : 0;
		Challenge.find({challengee: playerId, winner: null}, function(err, challenges) {
			if (err) {
				callback(err);
				return;
			}
			var incoming = 0;
			if (challenges)
				incoming = challenges.length;
			callback(err, incoming, outgoing);
		});
	});
}

function getResolvedChallenges(challenger, challengee, callback) {
	Challenge.find({$or: [ 
			{$and: [{challenger: challenger._id}, {challengee: challengee._id}, {winner: {$ne: null}}]}, 
			{$and: [{challenger: challengee._id}, {challengee: challenger._id}, {winner: {$ne: null}}]}
		]}, function(err, challenges) {
			if (err) {
				callback(err);
				return;
			} else {
				callback(null, challenges);
			}
	});
}

/*
 * Swaps the rankings for two given players.
 *
 * @param: winner
 * @param: loser
 *
 * @return: err
 */
function swapRanks(winner, loser, callback) {
	var swapped = false;
	if (winner.rank < loser.rank) {
		console.log('Swapping rankings is not required.');
		callback(null, swapped);
		return;
	}
	swapped = true;
	console.log('Swapping rankings between ' + winner.username + ' and ' + loser.username);
	setRank(winner, TEMP_RANK, function(err, oldRank, newRank) {
		if (err) {
			callback(err, swapped);
			return;
		}
		var player1_oldRank = oldRank;
		setRank(loser, player1_oldRank, function(err, oldRank, newRank) {
			if (err) {
				callback(err, swapped);
				return;
			}
			var player2_oldRank = oldRank;
			setRank(winner, player2_oldRank, function(err, oldRank, newRank) {
				console.log('Swapping rankings completed successfully.');
				callback(err, swapped);
			});
		});
	});
}


/*
 * Manually sets the rank of a given player.
 *
 * @param: playerId
 * @param: newRank
 *
 * @return: err
 * @return: oldRank
 * @return: newRank
 */
var TEMP_RANK = -1;
function setRank(playerId, newRank, callback) {
	Player.findById(playerId, function(err, player) {
		if (err) {
			callback(err, null, null);
			return;
		}
		var oldRank = player.rank;
		player.rank = newRank;
		player.save(function(err) {
			callback(err, oldRank, newRank);
		});
	});
}


/*
 * Updates the last game time of both players.
 *
 * @param: challenge
 *
 * @return: err
 */
function updateLastGames(challenge, callback) {
	if (!challenge.challenger._id || !challenge.challengee._id) {
		console.log("This error is likely caused by not calling populate().")
		callback(new Error('Two players were not provided.'));
		return;
	}
	
	var gameTime = challenge.updatedAt;
	if (!gameTime) {
		console.log("This error is likely caused by not saving the challenge first.");
		callback(new Error('Challenge time was not updated.'));
		return;
	}
	
	var challengerId = challenge.challenger._id;
	var challengeeId = challenge.challengee._id;
	
	// Update challenger
	Player.findByIdAndUpdate(challengerId, {$set: {lastGame: gameTime}}, function(err, player) {
		if (err) {
			callback(err);
			return;
		}
		
		// Update challengee
		Player.findByIdAndUpdate(challengeeId, {$set: {lastGame: gameTime}}, function(err, player) {
			if (err) {
				callback(err);
				return;
			}
			
			// Done successfully
			callback(null);
		});
	});
}


module.exports = router;
