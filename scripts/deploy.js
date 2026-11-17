// One-command, re-runnable deployment:  npm run deploy   (Sepolia)  |  npm run deploy:local
const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}\nDeployer: ${deployer.address}`);

  const token = await (await ethers.getContractFactory("CampusToken")).deploy(ethers.parseEther("1000000"));
  await token.waitForDeployment();
  const vault = await (await ethers.getContractFactory("CommitVault")).deploy(await token.getAddress());
  await vault.waitForDeployment();

  // Seed the reward pool: 10,000 CPT streamed over 30 days.
  const seed = ethers.parseEther("10000");
  await (await token.approve(await vault.getAddress(), seed)).wait();
  await (await vault.fundRewards(seed, 30 * 24 * 3600)).wait();

  const out = { network: network.name, token: await token.getAddress(), vault: await vault.getAddress(), deployer: deployer.address };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/${network.name}.json`, JSON.stringify(out, null, 2));
  console.log(out);

  if (network.name === "sepolia") {
    console.log("\nVerify on Etherscan (wait ~1 minute first):");
    console.log(`npx hardhat verify --network sepolia ${out.token} 1000000000000000000000000`);
    console.log(`npx hardhat verify --network sepolia ${out.vault} ${out.token}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
