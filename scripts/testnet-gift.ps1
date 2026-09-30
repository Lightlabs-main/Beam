# First gasless gift on Monad testnet: viewer signs off-chain, relayer submits and pays gas.
param([switch]$Send)
$ErrorActionPreference = 'Stop'
$cast = "$env:USERPROFILE\.foundry\bin\cast.exe"
$rpc = 'https://testnet-rpc.monad.xyz'
$usdc = '0x534b2f3A21130d7a60830c2Df862319e593943A3'
$gifts = '0x649Cdc9A801a8d7918f28FBB3b178568bcFBF0a7'
$envFile = Join-Path $PSScriptRoot '..\.env'

function EnvVal($name) { (Get-Content $envFile | Select-String "^$name=").Line.Split('=', 2)[1] }
function C { $out = & $cast @args; if ($LASTEXITCODE -ne 0) { throw "cast $($args[0]) failed" }; ($out | Select-Object -First 1).ToString().Split(' ')[0] }

if (-not (Get-Content $envFile | Select-String '^CREATOR_ADDRESS=')) {
    $w = (& $cast wallet new --json | ConvertFrom-Json).data[0]
    Add-Content $envFile @('', '# Test creator (testnet only). Receives gifts.', "CREATOR_ADDRESS=$($w.address)", "CREATOR_PRIVATE_KEY=$($w.private_key)")
}
$viewer = EnvVal 'VIEWER_ADDRESS'; $viewerKey = EnvVal 'VIEWER_PRIVATE_KEY'
$relayer = EnvVal 'RELAYER_ADDRESS'; $relayerKey = EnvVal 'RELAYER_PRIVATE_KEY'
$creator = EnvVal 'CREATOR_ADDRESS'

$value = 1000000  # 1 USDC
$meta = '(JUDGE,first gasless gift on Monad,1)'
$salt = C keccak "beam-first-gift-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$validBefore = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600

# The nonce the viewer signs binds recipient, message, action code and salt.
$nonce = C call $gifts 'giftNonce(address,address,(string,string,uint16),bytes32)(bytes32)' $viewer $creator $meta $salt --rpc-url $rpc
$typehash = C keccak 'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
$encoded = C abi-encode 'f(bytes32,address,address,uint256,uint256,uint256,bytes32)' $typehash $viewer $creator $value 0 $validBefore $nonce
$structHash = C keccak $encoded
$domain = C call $usdc 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url $rpc
$digest = C keccak ('0x1901' + $domain.Substring(2) + $structHash.Substring(2))

# Viewer signs off-chain. No transaction, no MON.
$sig = C wallet sign --no-hash --private-key $viewerKey $digest
$r = '0x' + $sig.Substring(2, 64); $s = '0x' + $sig.Substring(66, 64); $v = [Convert]::ToInt32($sig.Substring(130, 2), 16)
$auth = "($viewer,$value,0,$validBefore,$salt,$v,$r,$s)"
$fn = 'giftCreator(address,(string,string,uint16),(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32))'

function Bal($a) { C call $usdc 'balanceOf(address)(uint256)' $a --rpc-url $rpc }
"viewer   $viewer  USDC=$(Bal $viewer)  MON=$(C balance $viewer --rpc-url $rpc)"
"creator  $creator  USDC=$(Bal $creator)"
"relayer  $relayer  MON=$(C balance $relayer --ether --rpc-url $rpc)"
"nonce    $nonce"

# Simulate as the relayer first.
& $cast call $gifts $fn $creator $meta $auth --from $relayer --rpc-url $rpc | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'simulation failed' }
'simulation: ok'
if (-not $Send) { return }

$receipt = & $cast send $gifts $fn $creator $meta $auth --private-key $relayerKey --rpc-url $rpc --json | ConvertFrom-Json
"tx       $($receipt.transactionHash)"
"status   $($receipt.status)  block=$([Convert]::ToInt64($receipt.blockNumber,16))  gasUsed=$([Convert]::ToInt64($receipt.gasUsed,16))"
"tx.from  $($receipt.from)"
"viewer   USDC=$(Bal $viewer)  MON=$(C balance $viewer --rpc-url $rpc)"
"creator  USDC=$(Bal $creator)"
"relayer  MON=$(C balance $relayer --ether --rpc-url $rpc)"
"usedNonce=$(C call $usdc 'authorizationState(address,bytes32)(bool)' $viewer $nonce --rpc-url $rpc)"
