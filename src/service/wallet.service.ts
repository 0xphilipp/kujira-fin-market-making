import { Wallet } from "../app/wallet";
import { PrismaService } from "../config/prisma.service";
import { Injectable } from "@nestjs/common";

@Injectable()
export class WalletService {

  constructor(
    private prisma: PrismaService,
  ) {}

  async deleteWalletsNotIn(addresses: string[]) {
    await this.prisma.wallet.deleteMany({
      where: { address: {
          notIn: addresses,
        }
      }
    })
  }

  async getWallet(address: string) {
    return await this.prisma.wallet.findUnique({
      where: { address }
    })
  }

  async addWallets(wallets: Wallet[]) {
    wallets.map(async (wallet) => {
      const w = await this.getWallet(wallet.account.address);
      if (!w) {
        await this.prisma.wallet.create({
          data: {
            address: wallet.account.address,
          },
        })
      }
    })
  }
}