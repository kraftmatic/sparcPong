angular
	.module('filters')
	.filter('tier', tier);

tier.$inject = [];

function tier() {

	return function (players, tier) {
		var tierPlayers = [];
		
		if (!players) return tierPlayers;
		
		// Calculate possible ranks for the tier
		var ranks = getRanks(tier);

		angular.forEach(players, function(player) {
            angular.forEach(ranks, function(rank) {
            	if (player.rank === rank) tierPlayers.push(player);
			});
		});
		
		return tierPlayers.sort(playerSort);
	};
	
	function playerSort(a, b) {
		return a.rank > b.rank;
	}
	
	function getRanks(tier) {
        var ranks = [];
        var first = (tier * (tier-1) + 2) / 2;
        for (var r=0; r<tier; r++) {
            ranks.push(first+r);
        }
        return ranks;
	}

}
